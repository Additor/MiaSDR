import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("people.linkedin_url on every write path", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let org = "";
  let user = "";
  let actor: Actor;
  let uc: typeof import("../../application/lead-management");
  let found: typeof import("../../application/found-people");
  let deps: ReturnType<typeof import("../composition").leadDeps>;
  let foundStore: typeof import("../drizzle-found-people-store").drizzleFoundPeopleStore;

  beforeAll(async () => {
    uc = await import("../../application/lead-management");
    found = await import("../../application/found-people");
    foundStore = (await import("../drizzle-found-people-store")).drizzleFoundPeopleStore;
    deps = (await import("../composition")).leadDeps();
    const s = Math.random().toString(36).slice(2, 8);
    [{ id: org }] = await sql`insert into organizations (name, slug) values ('L', ${"lu-" + s}) returning id`;
    [{ id: user }] = await sql`insert into users (name, email) values ('U', ${s + "@lu.test"}) returning id`;
    actor = { userId: user, organizationId: org, role: "member" };
  });

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: org }], [user]);
    await sql.end();
  });

  const row = async (where: ReturnType<typeof sql>) => (await sql`select linkedin_slug, linkedin_url from people where organization_id = ${org} and ${where}`)[0];

  it("LinkedIn search results save the canonical URL", async () => {
    await found.importFoundPeople({ store: foundStore }, { organizationId: org, source: "linkedin_search", people: [{ key: "a", profile: "https://www.linkedin.com/in/Found-One?x=1", name: "Found One", headline: null }] });
    expect(await row(sql`linkedin_slug = 'found-one'`)).toEqual({ linkedin_slug: "found-one", linkedin_url: "https://www.linkedin.com/in/found-one/" });
  });

  it("editing the LinkedIn field sets, replaces and clears the URL with the slug", async () => {
    const [{ id }] = await sql`insert into people (organization_id, email) values (${org}, 'edit@lu.test') returning id`;
    await uc.updateLead(deps, actor, id, { linkedin: "linkedin.com/in/Edit-Me" });
    expect(await row(sql`id = ${id}`)).toEqual({ linkedin_slug: "edit-me", linkedin_url: "https://www.linkedin.com/in/edit-me/" });

    await uc.updateLead(deps, actor, id, { linkedin: "https://www.linkedin.com/company/acme/" });
    expect(await row(sql`id = ${id}`)).toEqual({ linkedin_slug: null, linkedin_url: "https://www.linkedin.com/company/acme/" });

    await uc.updateLead(deps, actor, id, { linkedin: "someone-else" });
    expect(await row(sql`id = ${id}`)).toEqual({ linkedin_slug: "someone-else", linkedin_url: "https://www.linkedin.com/in/someone-else/" });

    await uc.updateLead(deps, actor, id, { linkedin: "" });
    expect(await row(sql`id = ${id}`)).toEqual({ linkedin_slug: null, linkedin_url: null });
  });
});
