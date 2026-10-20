import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError } from "@/shared/errors";
import { bootDealsKit, holdLocks, waitForLockWaiters, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import type { AddContactDeps } from "../../application/add-contact";
import type { MakeContactDeps } from "../../application/make-contact";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Races ("Contacts and Companies CRUD" in docs/decisions.md), on two connections.
 * A merge of Globex into Acme holds the `globex` domain lock and has moved Globex's people, deleted the Globex row and written
 * the alias, all uncommitted. A person form save or an Add contact with the Globex domain waits on the domain lock, then reads
 * the committed alias and attaches to Acme; no Globex company comes back. Merge is its own use case, so the holder writes its
 * statements in the merge's order by hand. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("company domain races", () => {
  let kit: DealsKit;
  let leads: typeof import("../../application/lead-management");
  let leadDeps: import("../../application/lead-ports").LeadDeps;
  let addApp: typeof import("../../application/add-contact");
  let addDeps: AddContactDeps;
  let makeApp: typeof import("../../application/make-contact");
  let makeDeps: MakeContactDeps;
  let dbClient: typeof import("@/platform/db/client");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    leads = await import("../../application/lead-management");
    leadDeps = (await import("../composition")).leadDeps();
    addApp = await import("../../application/add-contact");
    makeApp = await import("../../application/make-contact");
    dbClient = await import("@/platform/db/client");
    const { drizzleContactStore, personTransaction } = await import("../drizzle-contact-store");
    const { appendPersonEvent } = await import("@/contexts/conversations/infrastructure/person-handling");
    const { conversionDeps } = await import("@/contexts/deals/infrastructure/deals-composition");
    const { conversionOutreach } = await import("@/contexts/outreach/infrastructure/drizzle-conversion-outreach");
    addDeps = { contacts: drizzleContactStore, appendEvent: appendPersonEvent };
    makeDeps = { ...conversionDeps, liveEnrollmentSummary: conversionOutreach.liveEnrollmentSummary, transaction: personTransaction };
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));

  /** Acme and Globex, and a merge of Globex into Acme that holds its locks and writes until `release`. */
  async function mergeInFlight(f: DealsOrg) {
    const acmeDomain = `acme-${f.tag}.test`;
    const globexDomain = `globex-${f.tag}.test`;
    const acme = await f.company("Acme", acmeDomain);
    const globex = await f.company("Globex", globexDomain);
    const globexPerson = await f.person({ companyId: globex });
    const merge = await holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      for (const domain of [acmeDomain, globexDomain].sort()) await tx`select pg_advisory_xact_lock(hashtextextended(${`leads-company-domain:${f.org}:${domain}`}, 0))`;
      await tx`update people set company_id = ${acme} where organization_id = ${f.org} and company_id = ${globex}`;
      await tx`delete from companies where id = ${globex}`;
      await tx`insert into company_domain_aliases (organization_id, company_id, domain, merged_company_id, merged_name) values (${f.org}, ${acme}, ${globexDomain}, ${globex}, 'Globex')`;
    });
    return { acme, globex, globexDomain, globexPerson, merge };
  }

  const companiesWith = (f: DealsOrg, domain: string) => kit.count("companies", f.org, `domain = '${domain}'`);

  it("a person form save with the Globex domain waits for the merge and attaches to Acme", async () => {
    const f = await kit.organization();
    const { acme, globexDomain, globexPerson, merge } = await mergeInFlight(f);
    const p = await f.person();
    const saving = settle(leads.updateLead(leadDeps, f.member, p, { companyDomain: globexDomain }));
    await waitForLockWaiters(kit.sql, 1);
    await merge.release();
    const { error } = await saving;
    expect(error).toBeNull();
    expect((await kit.one("select company_id from people where id = $1", [p])).company_id).toBe(acme);
    expect((await kit.one("select company_id from people where id = $1", [globexPerson])).company_id).toBe(acme);
    expect(await companiesWith(f, globexDomain)).toBe(0);
  });

  it("an Add contact with the Globex domain waits for the merge and attaches to Acme", async () => {
    const f = await kit.organization();
    const { acme, globexDomain, merge } = await mergeInFlight(f);
    const adding = settle(dbClient.db.transaction((tx) => addApp.addContact(addDeps, tx, f.member, { email: `new-${f.tag}@acme.test`, companyDomain: globexDomain, creationKey: `race-key-${f.tag}` })));
    await waitForLockWaiters(kit.sql, 1);
    await merge.release();
    const { value, error } = await adding;
    expect(error).toBeNull();
    expect((await kit.one("select company_id, lifecycle from people where id = $1", [value?.personId])).company_id).toBe(acme);
    expect(await companiesWith(f, globexDomain)).toBe(0);
  });

  it("two Make contact calls on one lead: one converts, the other answers already_converted", async () => {
    const f = await kit.organization();
    const p = await f.person();
    // Hold the person's advisory lock so both calls queue behind it, then let them go together.
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`person-outreach:${f.org}:${p}`}, 0))`);
    const first = settle(makeApp.makeContact(makeDeps, f.member, p));
    const second = settle(makeApp.makeContact(makeDeps, f.owner, p));
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const results = await Promise.all([first, second]);
    const codes = results.map((r) => (r.error instanceof ConflictError ? r.error.details?.code : r.error ? "other" : "ok")).sort();
    expect(codes).toEqual(["already_converted", "ok"]);
    expect(await kit.count("events", f.org, `event_type = 'lifecycle.converted'`)).toBe(1);
  });
});
