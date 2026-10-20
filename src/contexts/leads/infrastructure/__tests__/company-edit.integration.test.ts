import { afterAll, beforeAll, expect, it } from "vitest";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("company edit", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/company-management");
  let columns: typeof import("../../application/custom-columns");
  let deps: import("../../application/company-management").CompanyDeps;
  let columnStore: import("../../application/custom-columns").CustomColumnStore;
  const orgs: string[] = [];
  const users: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('C', ${"ce-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@ce.test"}) returning id`;
    users.push(userId);
    orgs.push(id);
    const admin: Actor = { userId, organizationId: id, role: "admin" };
    return { id, admin, member: { ...admin, role: "member" } as Actor };
  }
  const company = async (orgId: string, custom: object = {}) => {
    const [{ id }] = await sql`insert into companies (organization_id, domain, name, custom) values (${orgId}, ${`c${Math.random()}.test`}, 'Old', ${sql.json(custom as never)}) returning id`;
    return id as string;
  };
  const row = async (id: string) => (await sql`select name, linkedin_url, custom from companies where id = ${id}`)[0];

  beforeAll(async () => {
    uc = await import("../../application/company-management");
    columns = await import("../../application/custom-columns");
    deps = (await import("../composition")).companyDeps();
    columnStore = (await import("../drizzle-custom-column-store")).drizzleCustomColumnStore;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("lets a member change the name, LinkedIn page and a company field, and keeps other values", async () => {
    const { id: orgId, admin, member } = await org();
    const tier = await columns.createCustomColumn(columnStore, admin, { entity: "companies", name: "Tier" });
    const id = await company(orgId, { x_legacy: "kept" });
    await uc.updateCompany(deps, member, id, { name: "Acme", linkedin: "linkedin.com/company/acme", custom: { [tier.key]: "Gold" } });
    expect(await row(id)).toMatchObject({ name: "Acme", linkedin_url: "https://www.linkedin.com/company/acme/", custom: { x_legacy: "kept", [tier.key]: "Gold" } });

    await uc.updateCompany(deps, member, id, { custom: { [tier.key]: "" } });
    expect((await row(id)).custom).toEqual({ x_legacy: "kept" });
  });

  it("refuses a value for an archived company field", async () => {
    const { id: orgId, admin } = await org();
    const tier = await columns.createCustomColumn(columnStore, admin, { entity: "companies", name: "Tier" });
    await columns.archiveCustomColumn(columnStore, admin, tier.id);
    const id = await company(orgId);
    await expect(uc.updateCompany(deps, admin, id, { custom: { [tier.key]: "Gold" } })).rejects.toThrow(ValidationError);
    expect((await row(id)).custom).toEqual({});
  });

  it("answers not found for another organization's company and a malformed id", async () => {
    const { admin } = await org();
    const { id: otherOrg } = await org();
    const foreign = await company(otherOrg);
    await expect(uc.updateCompany(deps, admin, foreign, { name: "Taken" })).rejects.toThrow(NotFoundError);
    await expect(uc.updateCompany(deps, admin, "nope", { name: "Taken" })).rejects.toThrow(NotFoundError);
    expect((await row(foreign)).name).toBe("Old");
  });
});
