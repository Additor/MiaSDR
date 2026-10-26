import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, type Identity } from "@/test-support/route-client";
import { signedInUser, useTestEnvironment } from "@/test-support/identity-fixture";
import { describeDb, TEST_DATABASE_URL, testSql } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Invite-only signup: only owners and admins of the first organization may create more. */
describeDb("create organization (AUTH_SIGNUP=invite-only)", () => {
  const sql = testSql({ max: 3 });
  const tag = Math.random().toString(36).slice(2, 8);
  const created: string[] = [];
  let member: Identity;
  let outsider: Identity;
  let first: string;

  beforeAll(async () => {
    useTestEnvironment(TEST_DATABASE_URL ?? "", "invite-only");
    const { runMigrations } = await import("@/platform/db/migrate");
    await runMigrations();
    // "First organization" is the oldest row on the instance, so the test cannot rely on its own rows being the oldest.
    const [oldest] = await sql<{ id: string }[]>`select id from organizations order by created_at asc limit 1`;
    first = oldest?.id ?? (await sql<{ id: string }[]>`insert into organizations (name, slug) values ('First', ${`first-${tag}`}) returning id`)[0].id;
    if (!oldest) created.push(first);
    member = await signedInUser(sql, `member-${tag}`, [{ organizationId: first, role: "member" }]);
    outsider = await signedInUser(sql, `outsider-${tag}`);
  }, 120_000);

  afterAll(async () => {
    for (const id of created) await sql`delete from organizations where id = ${id}`;
    await sql`delete from users where email like '%@identity-fixture.test' and name like ${`%-${tag}`}`;
    await sql.end();
  });

  it("refuses a plain member and a user with no organization with 403, and creates nothing", async () => {
    for (const user of [member, outsider]) {
      const res = await callRoute("organizations/route.ts", "POST", { as: user, json: { name: `Nope ${tag}` } });
      expect(res.status, res.text).toBe(403);
    }
    // Other test files create organizations in parallel, so count only what these two users could have made.
    expect(await sql`select 1 from organizations where name = ${`Nope ${tag}`}`).toHaveLength(0);
    expect(await sql`select 1 from members where user_id in ${sql([member.userId, outsider.userId])} and organization_id <> ${first}`).toHaveLength(0);
  });

  it("reports canCreate false to them and true to an admin of the first organization", async () => {
    const asMember = (await callRoute("organizations/route.ts", "GET", { as: member })).body as { canCreate: boolean };
    expect(asMember.canCreate).toBe(false);
    const admin = await signedInUser(sql, `admin-${tag}`, [{ organizationId: first, role: "admin" }]);
    const asAdmin = (await callRoute("organizations/route.ts", "GET", { as: admin })).body as { canCreate: boolean };
    expect(asAdmin.canCreate).toBe(true);
    const res = await callRoute("organizations/route.ts", "POST", { as: admin, json: { name: `Second ${tag}` } });
    expect(res.status, res.text).toBe(201);
    created.push((res.body as { id: string }).id);
  });
});
