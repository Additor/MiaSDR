import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, TEST_DATABASE_URL, testSql } from "@/test-support/db";
import { signedInUser, useTestEnvironment } from "@/test-support/identity-fixture";
import { callRoute, type Identity } from "@/test-support/route-client";
import { ORGANIZATION_HEADER } from "./api-organization";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** The session names one active organization for every tab, so a page rendered for another one must not act on it. */
describeDb("a request from a page rendered for another organization", () => {
  const sql = testSql({ max: 3 });
  const tag = Math.random().toString(36).slice(2, 8);
  let member: Identity;
  let other: string;
  const created: string[] = [];

  beforeAll(async () => {
    useTestEnvironment(TEST_DATABASE_URL ?? "", "open");
    const [{ id: a }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('A', ${`a-${tag}`}) returning id`;
    const [{ id: b }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('B', ${`b-${tag}`}) returning id`;
    created.push(a, b);
    other = b;
    member = await signedInUser(sql, `fence-${tag}`, [{ organizationId: a, role: "owner" }, { organizationId: b, role: "owner" }]);
  }, 120_000);

  afterAll(async () => {
    for (const id of created) await sql`delete from organizations where id = ${id}`;
    await sql`delete from users where id = ${member.userId}`;
    await sql.end();
  });

  const read = (headers?: Record<string, string>) => callRoute("settings/replies/route.ts", "GET", { as: member, headers });

  it("answers when it names the session's organization, or none", async () => {
    expect((await read()).status).toBe(200);
    expect((await read({ [ORGANIZATION_HEADER]: member.organizationId })).status).toBe(200);
  });

  it("refuses when the session moved to another organization", async () => {
    const res = await read({ [ORGANIZATION_HEADER]: other });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "organization_changed" });
  });
});
