import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { bootDealsKit, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * The person form's company ("Contacts and Companies CRUD" in docs/decisions.md). An existing company keeps its
 * name and a different one answers 422; another domain of a company lands on it; a contact who leaves a company keeps that
 * company in Companies. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("person form company", () => {
  let kit: DealsKit;
  let uc: typeof import("../../application/lead-management");
  let deps: import("../../application/lead-ports").LeadDeps;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    uc = await import("../../application/lead-management");
    deps = (await import("@/composition/leads")).leadDeps();
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const save = (actor: Actor, id: string, input: import("../../domain/lead-edit").LeadEditInput) => uc.updateLead(deps, actor, id, input);
  const companyOf = async (personId: string) => (await kit.one("select company_id from people where id = $1", [personId])).company_id as string | null;
  const companyRow = async (id: string) => kit.one("select name, version, crm_listed_at from companies where id = $1", [id]);
  const world = async () => {
    const f = await kit.organization();
    const acmeDomain = `acme-${f.tag}.test`;
    const acme = await f.company("Acme", acmeDomain);
    return { f, acme, acmeDomain };
  };
  const errorOf = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e);

  it("refuses a different name for an existing company and changes nothing", async () => {
    const { f, acme, acmeDomain } = await world();
    const p = await f.person();
    const error = await errorOf(save(f.member, p, { companyDomain: acmeDomain, companyName: "Acme Inc", title: "CTO" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe("Rename Acme on its company page.");
    expect(await companyOf(p)).toBeNull();
    expect(await companyRow(acme)).toMatchObject({ name: "Acme", version: 0 });
    expect((await kit.one("select title from people where id = $1", [p])).title).toBeNull();
  });

  it("attaches with the same name or no name, and names a company only when its domain is new", async () => {
    const { f, acme, acmeDomain } = await world();
    const p = await f.person();
    await save(f.member, p, { companyDomain: acmeDomain, companyName: "Acme" });
    expect(await companyOf(p)).toBe(acme);
    await save(f.member, p, { companyDomain: acmeDomain, companyName: "" });
    expect(await companyOf(p)).toBe(acme);

    await save(f.member, p, { companyDomain: `https://www.new-${f.tag}.test/about`, companyName: "Newco" });
    const [created] = await kit.sql`select id, name, source, version from companies where organization_id = ${f.org} and domain = ${`new-${f.tag}.test`}`;
    expect(created).toMatchObject({ name: "Newco", source: "manual", version: 0 });
    expect(await companyOf(p)).toBe(created.id);
  });

  it("refuses a different name for an unnamed company too", async () => {
    const f = await kit.organization();
    const [{ id }] = await kit.sql`insert into companies (organization_id, domain) values (${f.org}, ${`bare-${f.tag}.test`}) returning id`;
    const p = await f.person();
    const error = await errorOf(save(f.member, p, { companyDomain: `bare-${f.tag}.test`, companyName: "Bare" }));
    expect((error as Error).message).toBe(`Rename bare-${f.tag}.test on its company page.`);
    expect(await companyRow(id)).toMatchObject({ name: null });
  });

  it("lands an other domain on the company that holds it", async () => {
    const { f, acme } = await world();
    await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain) values (${f.org}, ${acme}, ${`globex-${f.tag}.test`})`;
    const p = await f.person();
    await save(f.member, p, { companyDomain: `globex-${f.tag}.test` });
    expect(await companyOf(p)).toBe(acme);
    expect(await kit.count("companies", f.org)).toBe(1);
  });

  it("refuses a webmail domain the person does not have yet", async () => {
    const { f } = await world();
    const p = await f.person();
    const error = await errorOf(save(f.member, p, { companyDomain: "gmail.com" }));
    expect((error as Error).message).toBe("gmail.com is an email provider, not a company domain.");
  });

  describe("the last-contact stamp", () => {
    const move = async (f: DealsOrg, personId: string, domain: string | null) => save(f.member, personId, { companyDomain: domain ?? "" });

    it("stamps a company whose last contact moves away, once", async () => {
      const { f, acmeDomain } = await world();
      const initech = await f.company("Initech");
      const contact = await f.person({ companyId: initech, contact: true });
      await move(f, contact, acmeDomain);
      const row = await companyRow(initech);
      expect(row.crm_listed_at).not.toBeNull();
      expect(row.version).toBe(1);
      // A second stamp never moves the time.
      const back = await f.person({ companyId: initech, contact: true });
      await move(f, back, null);
      expect(await companyRow(initech)).toMatchObject({ version: 1, crm_listed_at: row.crm_listed_at });
    });

    it("does not stamp while another contact stays, nor for a lead that leaves", async () => {
      const { f, acmeDomain } = await world();
      const initech = await f.company("Initech");
      const leaving = await f.person({ companyId: initech, contact: true });
      await f.person({ companyId: initech, contact: true });
      await move(f, leaving, acmeDomain);
      expect((await companyRow(initech)).crm_listed_at).toBeNull();

      const hooli = await f.company("Hooli");
      const lead = await f.person({ companyId: hooli });
      await move(f, lead, null);
      expect(await companyRow(hooli)).toMatchObject({ crm_listed_at: null, version: 0 });
    });

    it("does not stamp when the contact saves without moving", async () => {
      const { f, acme, acmeDomain } = await world();
      const contact = await f.person({ companyId: acme, contact: true });
      await save(f.member, contact, { companyDomain: acmeDomain, companyName: "Acme", title: "VP" });
      expect(await companyRow(acme)).toMatchObject({ crm_listed_at: null, version: 0 });
    });
  });
});
