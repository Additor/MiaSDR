import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { bootDealsKit, holdLocks, waitForLockWaiters, type DealsKit } from "@/test-support/deals-test-kit";
import type { CompanyLifecycleDeps } from "../../application/company-lifecycle";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Races ("Contacts and Companies CRUD" in docs/decisions.md), on two connections: a merge waits for a running import and
 * holds off the next; two merges of one pair in opposite directions leave one merge and a 404; a merge that cannot get a domain
 * lock answers `try_again` after its retry; a person save that waits on a company delete creates a new company by domain.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("company merge races", () => {
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

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));
  const expected = (otherPeople = 0) => ({ keptVersion: 0, otherVersion: 0, keptPeople: 0, otherPeople });

  it("waits for a running import and merges after it commits", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    const globex = await f.company("Globex");
    // An import holds `leads-import` and adds a Globex lead before it commits.
    const importer = await holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`leads-import:${f.org}`}, 0))`;
    });
    let finished = false;
    const merging = settle(app.mergeCompanies(deps, f.member, acme, globex, { expected: expected(1) }).finally(() => (finished = true)));
    await waitForLockWaiters(kit.sql, 1);
    expect(finished).toBe(false);
    await f.person({ companyId: globex });
    await importer.release();
    const { value, error } = await merging;
    expect(error).toBeNull();
    expect(value).toEqual({ companyId: acme, moved: { people: 1 } });
    expect(await kit.count("companies", f.org)).toBe(1);
  });

  it("merges one way when two merges of one pair run in opposite directions", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    const globex = await f.company("Globex");
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`leads-import:${f.org}`}, 0))`);
    const one = settle(app.mergeCompanies(deps, f.member, acme, globex, { expected: expected() }));
    const two = settle(app.mergeCompanies(deps, f.owner, globex, acme, { expected: expected() }));
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const results = await Promise.all([one, two]);
    const outcomes = results.map((r) => (r.error instanceof NotFoundError ? "gone" : r.error ? String(r.error) : "merged")).sort();
    expect(outcomes).toEqual(["gone", "merged"]);
    expect(await kit.count("companies", f.org)).toBe(1);
    expect(await kit.count("company_domain_aliases", f.org)).toBe(1);
    expect(await kit.count("audit_log", f.org, `action = 'company.merged'`)).toBe(1);
  });

  it("answers try_again when a domain lock stays held past the retry", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme");
    const globex = await f.company("Globex");
    const saving = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`leads-company-domain:${f.org}:globex-${f.tag}.test`}, 0))`);
    const { error } = await settle(app.mergeCompanies(deps, f.member, acme, globex, { expected: expected() }));
    await saving.release();
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toEqual({ code: "try_again" });
    expect(await kit.count("companies", f.org)).toBe(2);
  });

  it("a person save that waits on a company delete creates a new company by domain", async () => {
    const f = await kit.organization();
    const domain = `acme-${f.tag}.test`;
    const acme = await f.company("Acme", domain);
    // The delete's statements in its order, uncommitted: `leads-import`, the domain lock, the row.
    const deleting = await holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`leads-import:${f.org}`}, 0))`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`leads-company-domain:${f.org}:${domain}`}, 0))`;
      await tx`delete from companies where id = ${acme}`;
    });
    const leads = await import("../../application/lead-management");
    const leadDeps = (await import("../composition")).leadDeps();
    const p = await f.person();
    const saving = settle(leads.updateLead(leadDeps, f.member, p, { companyDomain: domain }));
    await waitForLockWaiters(kit.sql, 1);
    await deleting.release();
    expect((await saving).error).toBeNull();
    const [row] = await kit.sql`select c.id, c.domain from people p join companies c on c.id = p.company_id where p.id = ${p}`;
    expect(row.domain).toBe(domain);
    expect(row.id).not.toBe(acme);
  });
});
