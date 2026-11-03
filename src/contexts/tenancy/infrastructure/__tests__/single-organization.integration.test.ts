import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, type Identity } from "@/test-support/route-client";
import { signedInUser, useTestEnvironment } from "@/test-support/identity-fixture";
import { describeDb, TEST_DATABASE_URL, testSql } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** One install serves one organization. These rows prove isolation and the fallbacks, so this file inserts two organizations itself. */
describeDb("one organization per install", () => {
  const sql = testSql({ max: 3 });
  const tag = Math.random().toString(36).slice(2, 8);
  const orgIds: string[] = [];
  const org = async (name: string) => {
    const [{ id }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${name}, ${`one-${name.toLowerCase()}-${tag}`}) returning id`;
    orgIds.push(id);
    return id;
  };
  const SETTINGS = "settings/organization/route.ts";

  let orgA: string;
  let orgB: string;
  let owner: Identity;

  beforeAll(async () => {
    useTestEnvironment(TEST_DATABASE_URL ?? "");
    const { runMigrations } = await import("@/platform/db/migrate");
    await runMigrations();
    orgA = await org("A");
    orgB = await org("B");
    owner = await signedInUser(sql, `owner-${tag}`, [{ organizationId: orgA, role: "owner" }]);
  }, 120_000);

  afterAll(async () => {
    for (const id of orgIds) await sql`delete from organizations where id = ${id}`;
    await sql`delete from users where email like '%@identity-fixture.test' and name like ${`%-${tag}`}`;
    await sql.end();
  });

  it("refuses Better Auth's create for an owner's session and for a server call that names a user, and writes nothing", async () => {
    const { auth } = await import("@/contexts/identity/infrastructure/auth");
    const slug = `refused-${tag}`;
    await expect(auth().api.createOrganization({ headers: new Headers({ cookie: owner.cookie }), body: { name: "Refused", slug } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(auth().api.createOrganization({ body: { name: "Refused", slug, userId: owner.userId } })).rejects.toMatchObject({ statusCode: 403 });
    expect(await sql`select 1 from organizations where slug = ${slug}`).toHaveLength(0);
    expect(await sql`select 1 from members where user_id = ${owner.userId} and organization_id <> ${orgA}`).toHaveLength(0);
  });

  it("treats an admin of the oldest organization as the operator, and nobody else", async () => {
    const { isInstanceOperator } = await import("@/contexts/identity/infrastructure/signup-facts");
    // Other test files add organizations in parallel, so this test finds the oldest row instead of assuming its own.
    const [{ id: first }] = await sql<{ id: string }[]>`select id from organizations order by created_at asc limit 1`;
    const admin = await signedInUser(sql, `operator-${tag}`, [{ organizationId: first, role: "admin" }]);
    const member = await signedInUser(sql, `member-${tag}`, [{ organizationId: first, role: "member" }]);
    const outsider = await signedInUser(sql, `outsider-${tag}`);
    expect(await isInstanceOperator(admin.userId)).toBe(true);
    expect(await isInstanceOperator(member.userId)).toBe(false);
    expect(await isInstanceOperator(outsider.userId)).toBe(false);
  });

  it("falls back to the remaining membership when the cached active organization has none (removed member)", async () => {
    const user = await signedInUser(sql, `removed-${tag}`, [{ organizationId: orgA, role: "member" }, { organizationId: orgB, role: "member" }]);
    // The signed cookie cache still names organization A. Remove the membership without touching the cookie.
    await sql`delete from members where organization_id = ${orgA} and user_id = ${user.userId}`;
    const res = await callRoute(SETTINGS, "GET", { as: user });
    expect(res.status, res.text).toBe(200);
    expect((res.body as { id: string }).id).toBe(orgB);
  });

  it("answers 401 for a removed member with no other organization", async () => {
    const user = await signedInUser(sql, `last-${tag}`, [{ organizationId: orgA, role: "member" }]);
    await sql`delete from members where user_id = ${user.userId}`;
    expect((await callRoute(SETTINGS, "GET", { as: user })).status).toBe(401);
  });
});
