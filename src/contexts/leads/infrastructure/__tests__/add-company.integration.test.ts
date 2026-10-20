import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { bootDealsKit, type DealsKit } from "@/test-support/deals-test-kit";
import type { CompanyLifecycleDeps } from "../../application/company-lifecycle";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Add company ("Contacts and Companies CRUD" in docs/decisions.md). A new domain answers 201 with a listed
 * company and a `company.created` audit row; a company with leads only gets listed (200); a listed company or another domain
 * of a company answers 409 `company_exists`. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("add company", () => {
  let kit: DealsKit;
  let app: typeof import("../../application/company-lifecycle");
  let deps: CompanyLifecycleDeps;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    app = await import("../../application/company-lifecycle");
    const { drizzleCompanyLifecycleStore } = await import("../drizzle-company-lifecycle-store");
    const { drizzleLeadsAudit } = await import("../drizzle-leads-audit");
    const { personTransaction } = await import("../drizzle-contact-store");
    deps = { companies: drizzleCompanyLifecycleStore, audit: drizzleLeadsAudit, transaction: personTransaction };
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const rejection = (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);
  const company = async (id: string) => (await kit.sql`select domain, name, linkedin_url, source, version, crm_listed_at from companies where id = ${id}`)[0];

  it("creates a listed company from a website and writes company.created", async () => {
    const f = await kit.organization();
    const result = await app.addCompany(deps, f.member, { domain: `https://www.Initech-${f.tag}.test/about`, name: " Initech ", linkedinUrl: "linkedin.com/company/initech" });
    expect(result).toMatchObject({ listed: true, created: true });
    const row = await company(result.companyId);
    expect(row).toMatchObject({ domain: `initech-${f.tag}.test`, name: "Initech", source: "manual", version: 0 });
    expect(row.linkedin_url).toContain("linkedin.com/company/initech");
    expect(row.crm_listed_at).not.toBeNull();
    const audit = await kit.sql`select action, entity_type, entity_id, actor_user_id, meta from audit_log where organization_id = ${f.org}`;
    expect(audit).toEqual([{ action: "company.created", entity_type: "company", entity_id: result.companyId, actor_user_id: f.member.userId, meta: { domain: `initech-${f.tag}.test`, name: "Initech" } }]);
  });

  it("lists a company that has leads only, bumps its version and writes no audit row", async () => {
    const f = await kit.organization();
    const nimbus = await f.company("Nimbus");
    await f.person({ companyId: nimbus });
    const result = await app.addCompany(deps, f.member, { domain: `nimbus-${f.tag}.test` });
    expect(result).toEqual({ companyId: nimbus, listed: true, created: false });
    const row = await company(nimbus);
    expect(row.crm_listed_at).not.toBeNull();
    expect(row.version).toBe(1);
    expect(row.name).toBe("Nimbus");
    expect(await kit.count("audit_log", f.org)).toBe(0);
  });

  it("answers company_exists for a listed company and for a company with a contact", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    await kit.sql`update companies set crm_listed_at = now() where id = ${acme}`;
    const globex = await f.company("Globex");
    await f.person({ companyId: globex, contact: true });
    for (const [id, domain] of [[acme, `acme-${f.tag}.test`], [globex, `globex-${f.tag}.test`]]) {
      const error = await rejection(app.addCompany(deps, f.member, { domain }));
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({ code: "company_exists", companyId: id, domain, viaAlias: false });
      expect((error as ConflictError).message).toBe(`${id === acme ? "Acme" : "Globex"} already uses ${domain}.`);
    }
    expect((await company(globex)).version).toBe(0);
  });

  it("answers company_exists with viaAlias for another domain of a company", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain, merged_name) values (${f.org}, ${acme}, ${`globex-${f.tag}.test`}, 'Globex')`;
    const error = await rejection(app.addCompany(deps, f.member, { domain: `globex-${f.tag}.test`, name: "Globex" }));
    expect((error as ConflictError).details).toMatchObject({ code: "company_exists", companyId: acme, name: "Acme", viaAlias: true });
    expect((error as ConflictError).message).toBe(`globex-${f.tag}.test is another domain of Acme.`);
    expect(await kit.count("companies", f.org)).toBe(1);
  });

  it("refuses a webmail domain, a value that is no domain and a LinkedIn URL that is no company page", async () => {
    const f = await kit.organization();
    const webmail = await rejection(app.addCompany(deps, f.member, { domain: "gmail.com" }));
    expect(webmail).toBeInstanceOf(ValidationError);
    expect((webmail as Error).message).toBe("gmail.com is an email provider, not a company domain.");
    const junk = await rejection(app.addCompany(deps, f.member, { domain: "not a domain" }));
    expect((junk as Error).message).toBe('"not a domain" is not a company domain or website.');
    const linkedin = await rejection(app.addCompany(deps, f.member, { domain: `ok-${f.tag}.test`, linkedinUrl: "linkedin.com/in/someone" }));
    expect(linkedin).toBeInstanceOf(ValidationError);
    expect(await kit.count("companies", f.org)).toBe(0);
  });
});
