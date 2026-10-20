import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { callRoute, type Identity } from "@/test-support/route-client";
import { signedInUser, useTestEnvironment } from "@/test-support/identity-fixture";
import { describeDb, TEST_DATABASE_URL, testSql } from "@/test-support/db";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** Open signup: any user may create organizations. Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("create, list and switch organizations (AUTH_SIGNUP=open)", () => {
  const sql = testSql({ max: 3 });
  const tag = Math.random().toString(36).slice(2, 8);
  const orgIds: string[] = [];
  const org = async (name: string) => {
    const [{ id }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${name}, ${`orgs-${name.toLowerCase()}-${tag}`}) returning id`;
    orgIds.push(id);
    return id;
  };
  const CREATE = "organizations/route.ts";
  const LIST = "organizations/route.ts";
  const ACTIVE = "organizations/active/route.ts";
  const activeOf = async (user: Identity) => (await sql`select active_organization_id as id from sessions where user_id = ${user.userId} order by created_at desc limit 1`)[0]?.id as string | null;

  let orgA: string;
  let orgB: string;
  let owner: Identity; // member of A only
  let both: Identity; // joined A, then B
  let nobody: Identity; // no organization yet
  let stranger: Identity; // member of B only

  beforeAll(async () => {
    useTestEnvironment(TEST_DATABASE_URL ?? "", "open");
    const { runMigrations } = await import("@/platform/db/migrate");
    await runMigrations();
    orgA = await org("A");
    orgB = await org("B");
    owner = await signedInUser(sql, `owner-${tag}`, [{ organizationId: orgA, role: "owner" }]);
    both = await signedInUser(sql, `both-${tag}`, [{ organizationId: orgA, role: "member" }, { organizationId: orgB, role: "admin" }]);
    nobody = await signedInUser(sql, `nobody-${tag}`);
    stranger = await signedInUser(sql, `stranger-${tag}`, [{ organizationId: orgB, role: "owner" }]);
  }, 120_000);

  afterAll(async () => {
    for (const id of orgIds) await sql`delete from organizations where id = ${id}`;
    await sql`delete from users where email like '%@identity-fixture.test' and name like ${`%-${tag}`}`;
    await sql.end();
  });

  it("lets a user with no organization create one: owner membership, slug from the name, active on the session", async () => {
    const res = await callRoute(CREATE, "POST", { as: nobody, json: { name: `  Fresh Co ${tag} ` } });
    expect(res.status, res.text).toBe(201);
    const created = res.body as { id: string; name: string; slug: string };
    orgIds.push(created.id);
    expect(created.name).toBe(`Fresh Co ${tag}`);
    expect(created.slug).toBe(`fresh-co-${tag}`);
    const [member] = await sql`select role from members where organization_id = ${created.id} and user_id = ${nobody.userId}`;
    expect(member.role).toBe("owner");
    expect(await activeOf(nobody)).toBe(created.id);
  });

  it("suffixes the slug when the name is taken", async () => {
    const name = `Same Name ${tag}`;
    const first = (await callRoute(CREATE, "POST", { as: owner, json: { name } })).body as { id: string; slug: string };
    const second = (await callRoute(CREATE, "POST", { as: both, json: { name } })).body as { id: string; slug: string };
    const third = (await callRoute(CREATE, "POST", { as: stranger, json: { name } })).body as { id: string; slug: string };
    orgIds.push(first.id, second.id, third.id);
    expect(first.slug).toBe(`same-name-${tag}`);
    expect(second.slug).toBe(`same-name-${tag}-2`);
    expect(third.slug).toBe(`same-name-${tag}-3`);
  });

  it("finds a free slug for a name long enough that the suffix cuts the base", async () => {
    const name = `${"q".repeat(40)}${tag}`; // slugifies to 46 characters, so `-10` cuts the base
    const slugs: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await callRoute(CREATE, "POST", { as: owner, json: { name } });
      expect(res.status).toBe(201);
      const created = res.body as { id: string; slug: string };
      orgIds.push(created.id);
      slugs.push(created.slug);
    }
    expect(new Set(slugs).size).toBe(12);
    expect(slugs.every((s) => s.length <= 48)).toBe(true);
  });

  it("rejects a blank or oversized name with 422 and creates nothing", async () => {
    const before = (await sql`select count(*)::int as n from organizations`)[0].n;
    expect((await callRoute(CREATE, "POST", { as: owner, json: { name: "   " } })).status).toBe(422);
    expect((await callRoute(CREATE, "POST", { as: owner, json: { name: "x".repeat(81) } })).status).toBe(422);
    expect((await callRoute(CREATE, "POST", { as: owner, json: {} })).status).toBe(400);
    expect((await sql`select count(*)::int as n from organizations`)[0].n).toBe(before);
  });

  it("lists only the caller's memberships and marks the active one", async () => {
    const res = await callRoute(LIST, "GET", { as: both });
    const body = res.body as { organizations: Array<{ id: string; active: boolean; role: string }>; canCreate: boolean };
    expect(body.canCreate).toBe(true);
    const ids = body.organizations.map((o) => o.id);
    expect(ids.slice(0, 2)).toEqual([orgA, orgB]);
    expect(body.organizations.filter((o) => o.active).map((o) => o.id)).toEqual([orgA]);
    // `both` also created "Same Name" above, so check isolation against the other users' organizations.
    const strangerOrgs = ((await callRoute(LIST, "GET", { as: stranger })).body as { organizations: Array<{ id: string }> }).organizations.map((o) => o.id);
    expect(strangerOrgs).not.toContain(orgA);
    const ownerOrgs = ((await callRoute(LIST, "GET", { as: owner })).body as { organizations: Array<{ id: string }> }).organizations.map((o) => o.id);
    expect(ownerOrgs).not.toContain(orgB);
    expect(ownerOrgs).toContain(orgA);
  });

  it("switches to an organization the user belongs to and stores it on the session", async () => {
    const user = await signedInUser(sql, `switcher-${tag}`, [{ organizationId: orgA, role: "member" }, { organizationId: orgB, role: "member" }]);
    const res = await callRoute(ACTIVE, "POST", { as: user, json: { organizationId: orgB } });
    expect(res.status, res.text).toBe(200);
    expect(await activeOf(user)).toBe(orgB);
  });

  it("answers 404 for an organization the user is not in, a non-uuid and an unknown id, and leaves the session alone", async () => {
    const before = await activeOf(owner);
    for (const organizationId of [orgB, "not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await callRoute(ACTIVE, "POST", { as: owner, json: { organizationId } });
      expect(res.status, `${organizationId}: ${res.text}`).toBe(404);
    }
    expect(await activeOf(owner)).toBe(before);
  });

  it("falls back to the other organization when the cached active one has no membership (removed member)", async () => {
    const user = await signedInUser(sql, `removed-${tag}`, [{ organizationId: orgA, role: "member" }, { organizationId: orgB, role: "member" }]);
    // The signed cookie cache still names organization A. Remove the membership without touching the cookie.
    await sql`delete from members where organization_id = ${orgA} and user_id = ${user.userId}`;
    const res = await callRoute("settings/organization/route.ts", "GET", { as: user });
    expect(res.status, res.text).toBe(200);
    expect((res.body as { id: string }).id).toBe(orgB);
  });

  it("answers 401 for a removed member with no other organization", async () => {
    const user = await signedInUser(sql, `last-${tag}`, [{ organizationId: orgA, role: "member" }]);
    await sql`delete from members where user_id = ${user.userId}`;
    expect((await callRoute("settings/organization/route.ts", "GET", { as: user })).status).toBe(401);
  });
});
