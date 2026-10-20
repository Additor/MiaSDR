import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import { bootDealsKit, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import type { CompanyLifecycleDeps, CompanyMergePreviewDeps } from "../../application/company-lifecycle";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Company merge ("Contacts and Companies CRUD" in docs/decisions.md). The preview's counts and value rules,
 * then the merge: people move and their deals follow, other domains move, raw data keeps the kept keys, `crm_listed_at` takes
 * the earlier stamp, `company_changed` on a version or a people count, and a replay answers from the audit row. The deal and
 * campaign counts come through ports this file wires over SQL. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("company merge", () => {
  let kit: DealsKit;
  let app: typeof import("../../application/company-lifecycle");
  let companyApp: typeof import("../../application/company-management");
  let companyDeps: import("../../application/company-management").CompanyDeps;
  let deals: typeof import("@/contexts/deals/application/deals");
  let dealsDeps: import("@/contexts/deals/application/deal-ports").DealsDeps;
  let deps: CompanyLifecycleDeps;
  let previewDeps: CompanyMergePreviewDeps;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    app = await import("../../application/company-lifecycle");
    companyApp = await import("../../application/company-management");
    companyDeps = (await import("../composition")).companyDeps();
    deals = await import("@/contexts/deals/application/deals");
    dealsDeps = (await import("@/contexts/deals/infrastructure/deals-composition")).dealsDeps();
    const { drizzleCompanyLifecycleStore } = await import("../drizzle-company-lifecycle-store");
    const { drizzleLeadsAudit } = await import("../drizzle-leads-audit");
    const { personTransaction } = await import("../drizzle-contact-store");
    deps = { companies: drizzleCompanyLifecycleStore, audit: drizzleLeadsAudit, transaction: personTransaction };
    previewDeps = {
      ...deps,
      mergeReads: {
        async dealCounts(org, companyId) {
          const [row] = await kit.sql`
            select count(*)::int as deals, (count(*) filter (where d.stage_kind = 'open'))::int as open_deals
            from deals d join people p on p.id = d.person_id and p.organization_id = d.organization_id
            where d.organization_id = ${org} and p.company_id = ${companyId}`;
          return { deals: row.deals, openDeals: row.open_deals };
        },
        async leadsInRunningCampaigns(org, companyId) {
          const [row] = await kit.sql`
            select count(distinct p.id)::int as n
            from people p join campaign_enrollments e on e.person_id = p.id join campaigns c on c.id = e.campaign_id
            where p.organization_id = ${org} and p.company_id = ${companyId} and p.lifecycle = 'lead' and e.status in ('pending', 'active') and c.status = 'active'`;
          return row.n;
        },
      },
    };
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const rejection = (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);
  const company = async (id: string) => (await kit.sql`select * from companies where id = ${id}`)[0];
  const field = (org: string, key: string, name: string, archived = false) =>
    kit.sql`insert into entity_columns (organization_id, entity, key, name, type, archived_at) values (${org}, 'companies', ${key}, ${name}, 'text', ${archived ? new Date() : null})`;

  /** Acme (kept) and Globex (merged): Globex has a contact with an open deal, a lead in a running campaign and an earlier other domain. */
  async function world(f: DealsOrg) {
    await field(f.org, "x_tier", "Tier");
    await field(f.org, "x_region", "Region");
    await field(f.org, "x_old", "Old", true);
    const acme = await f.company("Acme");
    const globex = await f.company("Globex");
    await kit.sql`update companies set custom = ${kit.sql.json({ x_tier: "Gold" })}, raw = ${kit.sql.json({ "Company size": "50", Industry: "Retail" })}, crm_listed_at = '2026-05-01T00:00:00Z' where id = ${acme}`;
    await kit.sql`update companies set linkedin_url = 'https://www.linkedin.com/company/globex/', custom = ${kit.sql.json({ x_tier: "Silver", x_region: "EMEA", x_old: "kept" })},
                  raw = ${kit.sql.json({ "Company size": "500", "Company city": "Oslo" })}, crm_listed_at = '2026-03-01T00:00:00Z' where id = ${globex}`;
    await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain, merged_name) values (${f.org}, ${globex}, ${`initech-${f.tag}.test`}, 'Initech')`;
    const acmeContact = await f.person({ companyId: acme, contact: true });
    const globexContact = await f.person({ companyId: globex, contact: true });
    const globexLead = await f.person({ companyId: globex });
    const deal = await deals.createDealForContact(dealsDeps, f.owner, globexContact, { idempotencyKey: `deal-key-${f.tag}`, title: "Globex expansion" });
    const campaign = await f.campaign();
    await f.enrollment(campaign, globexLead, "active");
    return { acme, globex, acmeContact, globexContact, globexLead, dealId: deal.dealId };
  }

  const expectedOf = (preview: Awaited<ReturnType<typeof app.previewCompanyMerge>>) => ({
    keptVersion: preview.kept.version,
    otherVersion: preview.other.version,
    keptPeople: preview.kept.people,
    otherPeople: preview.other.people,
  });

  it("previews the moves, the value conflicts, the filled fields and the other domains", async () => {
    const f = await kit.organization();
    const w = await world(f);
    const preview = await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex);
    expect(preview.kept).toEqual({ id: w.acme, name: "Acme", domain: `acme-${f.tag}.test`, version: 0, people: 1 });
    expect(preview.other).toEqual({ id: w.globex, name: "Globex", domain: `globex-${f.tag}.test`, version: 0, people: 2 });
    expect(preview.moves).toEqual({ contacts: 1, leads: 1, openDeals: 1, deals: 1, leadsInRunningCampaigns: 1 });
    expect(preview.fieldConflicts).toEqual([
      { key: "name", name: "name", kept: "Acme", other: "Globex" },
      { key: "x_tier", name: "Tier", kept: "Gold", other: "Silver" },
    ]);
    expect(preview.filledFields).toEqual([
      { key: "linkedin_url", name: "LinkedIn page", value: "https://www.linkedin.com/company/globex/" },
      { key: "x_region", name: "Region", value: "EMEA" },
      { key: "x_old", name: "Old", value: "kept" },
    ]);
    expect(preview.aliasDomains).toEqual([`initech-${f.tag}.test`]);
  });

  it("merges Globex into Acme: people, deals, values, raw data, other domains, stamp, version and the audit row", async () => {
    const f = await kit.organization();
    const w = await world(f);
    const preview = await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex);
    const result = await app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected: expectedOf(preview) });
    expect(result).toEqual({ companyId: w.acme, moved: { people: 2 } });

    expect(await company(w.globex)).toBeUndefined();
    const people = await kit.sql`select id, company_id from people where organization_id = ${f.org}`;
    expect(people.every((p) => p.company_id === w.acme)).toBe(true);
    const [deal] = await kit.sql`select person_id from deals where id = ${w.dealId}`;
    expect(deal.person_id).toBe(w.globexContact);

    const acme = await company(w.acme);
    expect(acme).toMatchObject({ name: "Acme", linkedin_url: "https://www.linkedin.com/company/globex/", version: 1 });
    expect(acme.custom).toEqual({ x_tier: "Gold", x_region: "EMEA", x_old: "kept" });
    expect(acme.raw).toEqual({ "Company size": "50", Industry: "Retail", "Company city": "Oslo" });
    expect(new Date(acme.crm_listed_at).toISOString()).toBe("2026-03-01T00:00:00.000Z");

    const aliases = await kit.sql`select domain, company_id, merged_company_id, merged_name, created_by from company_domain_aliases where organization_id = ${f.org} order by domain`;
    expect(aliases).toEqual([
      { domain: `globex-${f.tag}.test`, company_id: w.acme, merged_company_id: w.globex, merged_name: "Globex", created_by: f.member.userId },
      { domain: `initech-${f.tag}.test`, company_id: w.acme, merged_company_id: null, merged_name: "Initech", created_by: null },
    ]);

    const audit = await kit.sql`select action, entity_type, entity_id, meta from audit_log where organization_id = ${f.org}`;
    expect(audit).toEqual([
      {
        action: "company.merged",
        entity_type: "company",
        entity_id: w.acme,
        meta: {
          otherId: w.globex,
          otherDomain: `globex-${f.tag}.test`,
          otherName: "Globex",
          movedPeople: 2,
          fieldConflicts: [
            { key: "name", droppedValue: "Globex" },
            { key: "x_tier", droppedValue: "Silver" },
          ],
          rawDropped: {},
          rawOverwritten: { "Company size": "500" },
        },
      },
    ]);
  });

  it("replays a repeated merge from the audit row", async () => {
    const f = await kit.organization();
    const w = await world(f);
    const expected = expectedOf(await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex));
    await app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected });
    expect(await app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected })).toEqual({ companyId: w.acme, moved: { people: 2 } });
    expect(await kit.count("audit_log", f.org)).toBe(1);
    expect((await company(w.acme)).version).toBe(1);
  });

  it("stamps the kept company when neither side was listed", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    const globex = await f.company("Globex");
    await f.person({ companyId: globex });
    await app.mergeCompanies(deps, f.member, acme, globex, { expected: { keptVersion: 0, otherVersion: 0, keptPeople: 0, otherPeople: 1 } });
    expect((await company(acme)).crm_listed_at).not.toBeNull();
  });

  it("answers company_changed when a company edit bumped the version after the preview", async () => {
    const f = await kit.organization();
    const w = await world(f);
    const expected = expectedOf(await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex));
    await companyApp.updateCompany(companyDeps, f.owner, w.acme, { name: "Acme Inc" });
    expect((await company(w.acme)).version).toBe(1);
    const error = await rejection(app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected }));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toEqual({ code: "company_changed", companyId: w.acme });
    expect((error as ConflictError).message).toBe("Acme Inc changed while this was open. Check the preview again.");
    expect(await company(w.globex)).toMatchObject({ id: w.globex, version: 0 });
  });

  it("answers company_changed when a person joined the other company after the preview", async () => {
    const f = await kit.organization();
    const w = await world(f);
    const expected = expectedOf(await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex));
    await f.person({ companyId: w.globex });
    const error = await rejection(app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected }));
    expect((error as ConflictError).details).toEqual({ code: "company_changed", companyId: w.globex });
    expect(await kit.count("people", f.org, `company_id = '${w.globex}'`)).toBe(3);
  });

  it("answers same_company, 404 for a company of another organization, and 422 for a missing expected count", async () => {
    const f = await kit.organization();
    const g = await kit.organization();
    const acme = await f.company("Acme");
    const foreign = await g.company("Foreign");
    const expected = { keptVersion: 0, otherVersion: 0, keptPeople: 0, otherPeople: 0 };
    const same = await rejection(app.mergeCompanies(deps, f.member, acme, acme, { expected }));
    expect((same as ConflictError).details).toEqual({ code: "same_company" });
    expect((same as Error).message).toBe("Pick another company to merge.");
    expect(await rejection(app.previewCompanyMerge(previewDeps, f.member, acme, acme))).toBeInstanceOf(ConflictError);
    // The 404 names no company: the one that is missing has no name to give, and Acme is not the one that is gone.
    const missing = await rejection(app.previewCompanyMerge(previewDeps, f.member, acme, foreign));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as Error).message).not.toContain("Acme");
    const missingKept = await rejection(app.previewCompanyMerge(previewDeps, f.member, foreign, acme));
    expect(missingKept).toBeInstanceOf(NotFoundError);
    expect((missingKept as Error).message).not.toContain("Acme");
    expect(await rejection(app.mergeCompanies(deps, f.member, acme, foreign, { expected }))).toBeInstanceOf(NotFoundError);
    expect(await rejection(app.mergeCompanies(deps, f.member, acme, "not-a-uuid", { expected }))).toBeInstanceOf(NotFoundError);
    expect(await rejection(app.mergeCompanies(deps, f.member, acme, foreign, { expected: { keptVersion: 0 } }))).toBeInstanceOf(ValidationError);
    expect(await company(foreign)).toMatchObject({ id: foreign, name: "Foreign", version: 0 });
  });

  it("lands a later resolve of the merged domain on the kept company", async () => {
    const f = await kit.organization();
    const w = await world(f);
    await app.mergeCompanies(deps, f.member, w.acme, w.globex, { expected: expectedOf(await app.previewCompanyMerge(previewDeps, f.member, w.acme, w.globex)) });
    const store = await import("../company-domain-store");
    const match = await store.findCompanyByDomain(f.org, `globex-${f.tag}.test`);
    expect(match).toMatchObject({ companyId: w.acme, viaAlias: true, listed: true });
  });
});
