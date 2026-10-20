import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { callRoute, type Identity } from "@/test-support/route-client";
import { signedInUser } from "@/test-support/identity-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * DELETE /api/linkedin/search-batches/[id]/leads deletes staged results. A missing, empty or malformed body deletes nothing
 * and answers 400; deleting every result of the batch needs `all: true`. Needs TEST_DATABASE_URL.
 */

describeDb("DELETE /api/linkedin/search-batches/[id]/leads", () => {
  useTestEnv({ AUTH_SIGNUP: "open", RESEND_API_KEY: undefined, AUTH_EMAIL_FROM: undefined });
  const sql = testSql({ max: 3 });
  const tag = uniqueKey();
  const ROUTE = "linkedin/search-batches/[id]/leads/route.ts";
  let org: string;
  let owner: Identity;

  async function seed() {
    const [{ id: batch }] = await sql`insert into linkedin_search_batches (organization_id, name, kind, created_by) values (${org}, 'b', 'bulk', ${owner.userId}) returning id`;
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const [{ id }] = await sql`insert into linkedin_search_queries (organization_id, batch_id, url, status, leads_fetched) values (${org}, ${batch}, ${"https://www.linkedin.com/search/results/people/?keywords=" + tag + n}, 'completed', 2) returning id`;
      await sql`insert into linkedin_search_results (organization_id, query_id, profile_url) values (${org}, ${id}, ${"https://www.linkedin.com/in/a" + n + tag}), (${org}, ${id}, ${"https://www.linkedin.com/in/b" + n + tag})`;
      ids.push(id);
    }
    return { batch: batch as string, queries: ids };
  }
  const stored = async (batch: string) =>
    (await sql`select count(*)::int as n from linkedin_search_results r join linkedin_search_queries q on q.id = r.query_id where q.batch_id = ${batch}`)[0].n as number;
  const call = (batch: string, options: { json?: unknown; raw?: string }) => callRoute(ROUTE, "DELETE", { params: { id: batch }, as: owner, ...options });

  beforeAll(async () => {
    const { runMigrations } = await import("@/platform/db/migrate");
    await runMigrations();
    [{ id: org }] = await sql`insert into organizations (name, slug) values ('Leads route', ${"lr-" + tag}) returning id`;
    owner = await signedInUser(sql, `lr-owner-${tag}`, [{ organizationId: org, role: "owner" }]);
  }, 120_000);

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: org, userId: owner.userId }]);
    await sql.end();
  });

  it.each([
    ["no body", {}],
    ["an empty object", { json: {} }],
    ["malformed JSON", { raw: "{not json" }],
    ["an empty id list", { json: { ids: [] } }],
    ["all: false", { json: { all: false } }],
    ["a string for all", { json: { all: "true" } }],
    ["ids and all together", { json: { ids: ["00000000-0000-4000-8000-000000000001"], all: true } }],
    ["an unknown key", { json: { everything: true } }],
  ] as Array<[string, { json?: unknown; raw?: string }]>)("answers 400 and deletes nothing for %s", async (_label, options) => {
    const { batch } = await seed();
    const result = await call(batch, options);
    expect(result.status).toBe(400);
    expect(await stored(batch)).toBe(4);
  });

  it("deletes the results of the named searches only", async () => {
    const { batch, queries } = await seed();
    const result = await call(batch, { json: { ids: [queries[0]] } });
    expect(result.status).toBe(200);
    expect(await stored(batch)).toBe(2);
  });

  it("deletes every result of the batch with all: true and keeps the searches", async () => {
    const { batch } = await seed();
    const result = await call(batch, { json: { all: true } });
    expect(result.status).toBe(200);
    expect(await stored(batch)).toBe(0);
    expect((await sql`select count(*)::int as n from linkedin_search_queries where batch_id = ${batch}`)[0].n).toBe(2);
  });
});
