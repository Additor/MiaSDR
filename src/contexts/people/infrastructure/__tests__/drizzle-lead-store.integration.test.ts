import { afterAll, beforeAll, expect, it } from "vitest";
import type { Mapping } from "../../domain/import-plan";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const mapping: Mapping = {
  Email: "email",
  First: "first_name",
  Last: "last_name",
  Title: "title",
  Site: "company_domain",
  Company: "company_name",
  Size: "custom:회사 규모",
};

describeDb("drizzle lead store", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  let orgA = "";
  let orgB = "";
  let user = "";
  let run: typeof import("../../application/import-leads").importLeads;
  let store: typeof import("../drizzle-lead-store").drizzleLeadStore;

  const command = (organizationId: string, rows: Array<Record<string, string>>) => ({
    organizationId,
    userId: user,
    filename: "test.csv",
    headers: Object.keys(mapping),
    rows,
    mapping,
  });

  beforeAll(async () => {
    ({ importLeads: run } = await import("../../application/import-leads"));
    ({ drizzleLeadStore: store } = await import("../drizzle-lead-store"));

    const s = Math.random().toString(36).slice(2, 8);
    [{ id: orgA }] = await sql`insert into organizations (name, slug) values ('A', ${"la-" + s}) returning id`;
    [{ id: orgB }] = await sql`insert into organizations (name, slug) values ('B', ${"lb-" + s}) returning id`;
    [{ id: user }] = await sql`insert into users (name, email) values ('U', ${s + "@import.test"}) returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: orgA }, { organizationId: orgB }], [user]);
    await sql.end();
  });

  it("creates leads, companies and a custom column, and records the run", async () => {
    const report = await run({ store }, command(orgA, [
      { Email: "Ann@Acme.com", First: "Ann", Last: "Lee", Title: "CTO", Site: "https://acme.com", Company: "Acme", Size: "50" },
      { Email: "bob@acme.com", First: "Bob", Site: "acme.com" },
      { Email: "bad", First: "Nope" },
    ]));
    expect(report.stats).toMatchObject({ totalRows: 3, created: 2, updated: 0, invalid: 1, companiesCreated: 1 });

    const people = await sql`select email, full_name, custom, company_id is not null as has_company from people where organization_id = ${orgA} order by email`;
    expect(people.map((p) => p.email)).toEqual(["ann@acme.com", "bob@acme.com"]);
    expect(people[0].full_name).toBe("Ann Lee");
    expect(Object.values(people[0].custom)).toEqual(["50"]);
    expect(people.every((p) => p.has_company)).toBe(true);

    const [column] = await sql`select name, key from entity_columns where organization_id = ${orgA}`;
    expect(column.name).toBe("회사 규모");
    expect(column.key).toMatch(/^x_c_/);
    const [runRow] = await sql`select stats from import_runs where id = ${report.runId}`;
    expect(runRow.stats.created).toBe(2);
  });

  it("is idempotent: importing the same file again changes nothing", async () => {
    const rows = [{ Email: "ann@acme.com", First: "Ann", Last: "Lee", Title: "CTO", Site: "acme.com", Company: "Acme", Size: "50" }];
    const report = await run({ store }, command(orgA, rows));
    expect(report.stats).toMatchObject({ created: 0, updated: 0, unchanged: 1, companiesCreated: 0 });
  });

  it("updates changed values and never erases with an empty cell", async () => {
    const report = await run({ store }, command(orgA, [{ Email: "ann@acme.com", Title: "CEO", First: "", Last: "" }]));
    expect(report.stats.updated).toBe(1);
    const [ann] = await sql`select title, first_name, full_name from people where organization_id = ${orgA} and email = 'ann@acme.com'`;
    expect(ann).toMatchObject({ title: "CEO", first_name: "Ann", full_name: "Ann Lee" });
  });

  it("updates a contact's fields on re-import and leaves lifecycle and converted_at alone", async () => {
    await run({ store }, command(orgA, [{ Email: "dana@acme.com", First: "Dana", Title: "Analyst" }]));
    await sql`update people set lifecycle = 'contact', converted_at = '2026-10-01T10:00:00Z' where organization_id = ${orgA} and email = 'dana@acme.com'`;
    const report = await run({ store }, command(orgA, [{ Email: "dana@acme.com", First: "Dana", Title: "Director", Site: "acme.com", Company: "Acme" }]));
    expect(report.stats).toMatchObject({ created: 0, updated: 1 });
    const [dana] = await sql`select title, lifecycle, converted_at from people where organization_id = ${orgA} and email = 'dana@acme.com'`;
    expect(dana.title).toBe("Director");
    expect(dana.lifecycle).toBe("contact");
    expect(new Date(dana.converted_at).toISOString()).toBe("2026-10-01T10:00:00.000Z");
    // A lead stays a lead, and a brand-new row starts as a lead.
    const [ann] = await sql`select lifecycle, converted_at from people where organization_id = ${orgA} and email = 'ann@acme.com'`;
    expect(ann).toEqual({ lifecycle: "lead", converted_at: null });
  });

  it("keeps organizations apart: the same email in another organization is a new lead", async () => {
    const report = await run({ store }, command(orgB, [{ Email: "ann@acme.com", First: "Ann", Title: "Intern" }]));
    expect(report.stats).toMatchObject({ created: 1, updated: 0 });
    const [a] = await sql`select title from people where organization_id = ${orgA} and email = 'ann@acme.com'`;
    expect(a.title).toBe("CEO");
  });

  it("serializes two simultaneous imports of the same new leads without a unique violation", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ Email: `race${n}@acme.com`, First: `R${n}` }));
    const results = await Promise.all([run({ store }, command(orgA, rows)), run({ store }, command(orgA, rows))]);
    const created = results.reduce((sum, r) => sum + r.stats.created, 0);
    expect(created).toBe(5);
    const [{ count }] = await sql`select count(*)::int as count from people where organization_id = ${orgA} and email like 'race%'`;
    expect(count).toBe(5);
  });

  it("reports a conflict when email and LinkedIn name two different leads", async () => {
    await sql`insert into people (organization_id, email, linkedin_slug) values (${orgA}, 'carl@acme.com', 'carl-c')`;
    const m: Mapping = { Email: "email", LinkedIn: "linkedin" };
    const report = await run({ store }, {
      organizationId: orgA, userId: user, filename: null, headers: ["Email", "LinkedIn"], mapping: m,
      rows: [{ Email: "ann@acme.com", LinkedIn: "carl-c" }],
    });
    expect(report.stats).toMatchObject({ conflicts: 1, created: 0, updated: 0 });
  });
});
