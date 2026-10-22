import { afterAll, beforeAll, expect, it } from "vitest";
import { lockRetryStats } from "@/platform/db/errors";
import { bootDealsKit, holdLocks, sqlState, waitForLockWaiters, type DealsKit, type DealsOrg } from "../../../../test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * A conversion (the real `createDealFromLead`) racing the writers that meet it on one person, on two connections:
 *   (a) reply ingest for a person without a record, holding the advisory lock while the conversion starts;
 *   (b) ingest holding the person's record, on its way to the advisory lock while the conversion waits for the record;
 *   (c) `suppressEmail` (enrollments before records) for a person with a record, a run and a live enrollment;
 *   (d) ingest of a thread filed under person A with person B's address, racing a conversion of B;
 *   (e) `markSent` in flight.
 * Every writer is the real code: `ingestInbound`, `createSuppressionStore(...).suppressEmail`, `drizzleOutreachStore.markSent`.
 * A third connection holds one row or lock (a "gate") to stop a writer at a chosen statement; (c) pauses the conversion in
 * process at its enrollment step instead, because a lock wait of the conversion after it holds the person's records is bounded
 * by the 300 ms held-lock timeout on purpose. No case may lose state: the other writer always commits, and where Postgres has
 * to pick a victim the conversion gives way and its one retry succeeds.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("conversion races", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let composition: typeof import("@/composition/deals");
  let leadsApp: typeof import("@/contexts/people/application/convert-to-contact");
  let conversations: typeof import("@/contexts/conversations/infrastructure/composition");
  let suppression: Awaited<ReturnType<typeof import("@/test-support/suppression").suppressionStore>>;
  let outreachStore: typeof import("@/contexts/outreach/infrastructure/drizzle-outreach-store").drizzleOutreachStore;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    composition = await import("@/composition/deals");
    leadsApp = await import("@/contexts/people/application/convert-to-contact");
    conversations = await import("@/contexts/conversations/infrastructure/composition");
    const outreach = await import("@/contexts/outreach/infrastructure/drizzle-outreach-store");
    suppression = await (await import("@/test-support/suppression")).suppressionStore();
    outreachStore = outreach.drizzleOutreachStore;
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));
  const convert = (f: DealsOrg, personId: string, deps = composition.dealsDeps()) => settle(deals.createDealFromLead(deps, f.owner, personId));
  const lifecycle = async (personId: string) => (await kit.one("select lifecycle from people where id = $1", [personId])).lifecycle as string;
  const liveOf = async (personId: string) => kit.count("campaign_enrollments", (await kit.one("select organization_id from people where id = $1", [personId])).organization_id, `person_id = '${personId}' and status in ('pending', 'active')`);
  const inboundCount = async (f: DealsOrg, providerMessageId: string) => kit.count("messages", f.org, `provider_message_id = '${providerMessageId}' and direction = 'inbound'`);

  it("(a) ingest for a person without a record holds the advisory lock while the conversion starts: both commit, no retry", async () => {
    const f = await kit.organization();
    const email = `a-${f.tag}@acme.test`;
    const personId = await f.person({ email });
    const enrollment = await f.enrollment(await f.campaign(), personId, "active");
    const retries = lockRetryStats.retries;
    // The gate holds the enrollment, so the ingest stops at its reply stop, after the advisory lock.
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select id from campaign_enrollments where id = ${enrollment} for update`);
    const input = f.mail({ from: { email, name: "Ann" } });
    const ingest = settle(conversations.ingestInbound(input));
    await waitForLockWaiters(kit.sql, 1);
    expect(await kit.count("records", f.org, `person_id = '${personId}'`)).toBe(0);
    const conversion = convert(f, personId);
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const [ingested, converted] = await Promise.all([ingest, conversion]);
    expect(ingested.error).toBeNull();
    expect(converted.error).toBeNull();
    expect(lockRetryStats.retries).toBe(retries);
    expect(await inboundCount(f, input.providerMessageId)).toBe(1);
    expect(await lifecycle(personId)).toBe("contact");
    // The reply stopped the enrollment first, so the conversion had nothing left to stop.
    expect((await kit.one("select status from campaign_enrollments where id = $1", [enrollment])).status).toBe("replied");
    expect(converted.value?.stopped.enrollments).toBe(0);
  }, 30_000);

  it("(b) ingest holding the record goes on to the advisory lock while the conversion waits for the record: both commit, no retry", async () => {
    const f = await kit.organization();
    const first = await f.ingest();
    const enrollment = await f.enrollment(await f.campaign(), first.personId, "active");
    const [{ id: draftId }] = await kit.sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status, request)
      values (${f.org}, ${first.recordId}, ${first.conversationId}, 0, 'email', 'awaiting_review', '{}'::jsonb) returning id`;
    const retries = lockRetryStats.retries;
    // The gate holds an open draft, so the ingest stops at its stale-draft update, holding the record and not yet the advisory lock.
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select id from drafts where id = ${draftId} for update`);
    const input = f.mail({ from: first.input.from, providerThreadId: first.input.providerThreadId });
    const ingest = settle(conversations.ingestInbound(input));
    await waitForLockWaiters(kit.sql, 1);
    const conversion = convert(f, first.personId);
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const [ingested, converted] = await Promise.all([ingest, conversion]);
    expect(sqlState(ingested.error)).toBeUndefined();
    expect(ingested.error).toBeNull();
    expect(converted.error).toBeNull();
    expect(lockRetryStats.retries).toBe(retries);
    expect(await inboundCount(f, input.providerMessageId)).toBe(1);
    expect(await lifecycle(first.personId)).toBe("contact");
    expect((await kit.one("select status from campaign_enrollments where id = $1", [enrollment])).status).toBe("replied");
  }, 30_000);

  it("(c) suppressEmail holding the enrollment waits for the record the conversion holds: the conversion gives way, retries once, and both commit", async () => {
    const f = await kit.organization();
    const lead = await f.ingest();
    await f.emailedBy(lead.personId);
    await f.cycle();
    const live = await f.enrollment(await f.campaign(), lead.personId, "active");
    expect(await kit.count("sequence_runs", f.org, "status = 'active'")).toBe(1);
    const retries = lockRetryStats.retries;

    // The conversion stops in process before its enrollment step, holding the record, the advisory lock and the people row.
    let paused!: () => void;
    const reachedStop = new Promise<void>((resolve) => (paused = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let calls = 0;
    const conversion = { ...composition.conversionDeps };
    conversion.stopEnrollments = async (tx, input) => {
      calls += 1;
      if (calls === 1) {
        paused();
        await resumed;
      }
      return composition.conversionDeps.stopEnrollments(tx, input);
    };
    const deps = composition.dealsDeps({ convertLead: (tx, input) => leadsApp.convertToContact(conversion, tx, input) });
    const converting = convert(f, lead.personId, deps);
    await reachedStop;
    // suppressEmail takes the live enrollment, then waits for the record to end the run.
    const suppressing = settle(suppression.suppressEmail({ organizationId: f.org, email: lead.input.from.email, reason: "unsubscribed" }));
    await waitForLockWaiters(kit.sql, 1);
    resume();
    const [suppressed, converted] = await Promise.all([suppressing, converting]);
    expect(sqlState(suppressed.error)).toBeUndefined();
    expect(suppressed.error).toBeNull();
    expect(suppressed.value).toEqual({ stopped: 1, added: true });
    expect(converted.error).toBeNull();
    expect(lockRetryStats.retries).toBe(retries + 1);
    expect(calls).toBe(2);
    // No lost state: the address is suppressed, the enrollment stopped by the suppression, the run ended, the person a contact with a deal.
    expect(await kit.count("suppression_list", f.org, `email = '${lead.input.from.email.toLowerCase()}'`)).toBe(1);
    expect((await kit.one("select status, stop_reason from campaign_enrollments where id = $1", [live])).status).toBe("suppressed");
    expect(await kit.count("sequence_runs", f.org, "status in ('active', 'paused')")).toBe(0);
    expect(await lifecycle(lead.personId)).toBe("contact");
    expect(await kit.count("deals", f.org, `person_id = '${lead.personId}'`)).toBe(1);
  }, 60_000);

  it("(d) ingest filed under A with B's address, holding B's advisory lock, races a conversion of B: no lost reply, the conversion succeeds", async () => {
    const f = await kit.organization();
    const a = await f.ingest();
    const b = await f.ingest();
    await f.emailedBy(b.personId);
    await f.cycle();
    expect(await kit.count("sequence_runs", f.org, `status = 'active' and record_id = '${b.recordId}'`)).toBe(1);
    const bLive = await f.enrollment(await f.campaign(), b.personId, "active");
    const retries = lockRetryStats.retries;
    // The gate holds B's live enrollment: the ingest stops at the reply stop, holding A's record and both advisory locks.
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select id from campaign_enrollments where id = ${bLive} for update`);
    const input = f.mail({ providerThreadId: a.input.providerThreadId, from: b.input.from });
    const ingest = settle(conversations.ingestInbound(input));
    await waitForLockWaiters(kit.sql, 1);
    // The conversion of B locks B's record and waits for B's advisory lock.
    const conversion = convert(f, b.personId);
    await waitForLockWaiters(kit.sql, 2);
    // The ingest goes on to end B's run and asks for B's record: a cycle that the conversion breaks by giving way.
    await gate.release();
    const [ingested, converted] = await Promise.all([ingest, conversion]);
    expect(sqlState(ingested.error)).toBeUndefined();
    expect(ingested.error).toBeNull();
    expect(converted.error).toBeNull();
    expect(lockRetryStats.retries - retries).toBeLessThanOrEqual(1);
    expect(await inboundCount(f, input.providerMessageId)).toBe(1);
    expect((await kit.one("select status from campaign_enrollments where id = $1", [bLive])).status).toBe("replied");
    expect(await kit.count("sequence_runs", f.org, `status in ('active', 'paused') and record_id = '${b.recordId}'`)).toBe(0);
    expect(await lifecycle(b.personId)).toBe("contact");
    expect(await lifecycle(a.personId)).toBe("lead");
  }, 60_000);

  it("(e) markSent in flight against conversions of the same people: no deadlock, no retry, no live enrollment for a contact", async () => {
    const f = await kit.organization();
    const campaignId = await f.campaign();
    const [{ id: mailbox }] = await kit.sql`select id from mailboxes where organization_id = ${f.org}`;
    const rows: Array<{ personId: string; claim: unknown }> = [];
    const N = 60;
    for (let i = 0; i < N; i += 1) {
      const personId = await f.person();
      const status = i % 2 === 0 ? "active" : "pending";
      const enrollmentId = await f.enrollment(campaignId, personId, status);
      await kit.sql`update campaign_enrollments set current_step = ${status === "active" ? 1 : 0} where id = ${enrollmentId}`;
      const step = status === "active" ? 2 : 1;
      const [{ id: sendId }] = await kit.sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id) values (${f.org}, ${enrollmentId}, ${step}, 'email', 'sending', ${mailbox}) returning id`;
      rows.push({ personId, claim: { sendId, attempt: 1, enrollmentId, stepNumber: step, nextStep: { waitDays: 2 }, mailbox: { id: mailbox } } });
    }
    const retries = lockRetryStats.retries;
    const lanes = <T,>(items: T[], run: (item: T) => Promise<unknown>) =>
      [0, 1, 2, 3].map(async (lane) => {
        const errors: unknown[] = [];
        for (const item of items.filter((_, i) => i % 4 === lane)) await run(item).catch((error: unknown) => errors.push(error));
        return errors;
      });
    const sendErrors = lanes(rows, ({ claim }) => outreachStore.markSent(claim as never, { providerMessageId: `pm-${Math.random()}`, threadId: "t" }, new Date()));
    const convertErrors = lanes([...rows].reverse(), ({ personId }) => deals.createDealFromLead(composition.dealsDeps(), f.owner, personId));
    const errors = (await Promise.all([...sendErrors, ...convertErrors])).flat();
    expect(errors.map(sqlState)).not.toContain("40P01");
    expect(errors).toEqual([]);
    expect(lockRetryStats.retries).toBe(retries);
    expect(await kit.count("people", f.org, "lifecycle = 'contact'")).toBe(N);
    for (const { personId } of rows.slice(0, 4)) expect(await liveOf(personId)).toBe(0);
    const live = await kit.sql`select count(*)::int as n from campaign_enrollments e join people p on p.id = e.person_id where e.organization_id = ${f.org} and p.lifecycle = 'contact' and e.status in ('pending', 'active')`;
    expect(live[0].n).toBe(0);
    expect(await kit.count("sends", f.org, "status = 'sent'")).toBe(N);
  }, 120_000);

  it("a conversion waiting on a writer that never lets go ends with 409 try_again after one retry, and changes nothing", async () => {
    const f = await kit.organization();
    const lead = await f.ingest();
    const retries = lockRetryStats.retries;
    // The person's advisory lock, held elsewhere: the conversion holds the record and waits 300 ms, twice.
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`person-outreach:${f.org}:${lead.personId}`}, 0))`);
    const outcome = await convert(f, lead.personId).finally(() => gate.release());
    expect((outcome.error as { details?: { code?: string } }).details?.code).toBe("try_again");
    expect(lockRetryStats.retries).toBe(retries + 1);
    expect(await lifecycle(lead.personId)).toBe("lead");
  }, 30_000);
});
