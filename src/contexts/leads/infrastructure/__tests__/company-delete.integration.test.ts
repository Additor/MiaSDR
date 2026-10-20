import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { bootDealsKit, type DealsKit } from "@/test-support/deals-test-kit";
import type { CompanyLifecycleDeps } from "../../application/company-lifecycle";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Company delete ("Contacts and Companies CRUD" in docs/decisions.md). A company with a contact or a lead
 * answers 409 `company_in_use`; a stale version answers `company_changed`; an empty company goes with its other domains and
 * leaves a `company.deleted` audit row. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("company delete", () => {
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

  it("refuses a company with people and names what is left", async () => {
    const f = await kit.organization();
    const nimbus = await f.company("Nimbus");
    await f.person({ companyId: nimbus });
    const leadsOnly = await rejection(app.deleteCompany(deps, f.member, nimbus, { expectedVersion: 0 }));
    expect(leadsOnly).toBeInstanceOf(ConflictError);
    expect((leadsOnly as ConflictError).details).toEqual({ code: "company_in_use", contacts: 0, leads: 1 });
    expect((leadsOnly as Error).message).toBe("Nimbus still has 1 lead. Merge it into another company, or move those people first.");

    await f.person({ companyId: nimbus, contact: true });
    await f.person({ companyId: nimbus });
    const both = await rejection(app.deleteCompany(deps, f.member, nimbus));
    expect((both as ConflictError).details).toEqual({ code: "company_in_use", contacts: 1, leads: 2 });
    expect((both as Error).message).toBe("Nimbus still has 1 contact and 2 leads. Merge it into another company, or move those people first.");
    expect(await kit.count("companies", f.org)).toBe(1);
  });

  it("answers company_changed for a stale version", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    await kit.sql`update companies set version = 2 where id = ${acme}`;
    const error = await rejection(app.deleteCompany(deps, f.member, acme, { expectedVersion: 1 }));
    expect((error as ConflictError).details).toEqual({ code: "company_changed", companyId: acme });
    expect((error as Error).message).toBe("Acme changed while this was open. Check it and delete again.");
    expect(await kit.count("companies", f.org)).toBe(1);
  });

  it("deletes an empty company with its other domains and writes company.deleted", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain, merged_name) values (${f.org}, ${acme}, ${`globex-${f.tag}.test`}, 'Globex')`;
    await app.deleteCompany(deps, f.member, acme, { expectedVersion: 0 });
    expect(await kit.count("companies", f.org)).toBe(0);
    expect(await kit.count("company_domain_aliases", f.org)).toBe(0);
    const audit = await kit.sql`select action, entity_type, entity_id, actor_user_id, meta from audit_log where organization_id = ${f.org}`;
    expect(audit).toEqual([{ action: "company.deleted", entity_type: "company", entity_id: acme, actor_user_id: f.member.userId, meta: { domain: `acme-${f.tag}.test`, name: "Acme" } }]);
    // A replay finds nothing to delete.
    expect(await rejection(app.deleteCompany(deps, f.member, acme))).toBeInstanceOf(NotFoundError);
  });

  it("answers 404 for a company of another organization or a malformed id", async () => {
    const f = await kit.organization();
    const g = await kit.organization();
    const foreign = await g.company("Foreign");
    expect(await rejection(app.deleteCompany(deps, f.member, foreign))).toBeInstanceOf(NotFoundError);
    expect(await rejection(app.deleteCompany(deps, f.member, "nope"))).toBeInstanceOf(NotFoundError);
    expect(await kit.count("companies", g.org)).toBe(1);
  });

  it("lets a later person save create a new company for the deleted domain", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    await app.deleteCompany(deps, f.member, acme);
    const leads = await import("../../application/lead-management");
    const leadDeps = (await import("../composition")).leadDeps();
    const p = await f.person();
    await leads.updateLead(leadDeps, f.member, p, { companyDomain: `acme-${f.tag}.test` });
    const [row] = await kit.sql`select c.id, c.domain from people p join companies c on c.id = p.company_id where p.id = ${p}`;
    expect(row.domain).toBe(`acme-${f.tag}.test`);
    expect(row.id).not.toBe(acme);
  });
});
