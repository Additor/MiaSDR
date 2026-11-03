import { afterAll, beforeAll, expect, it } from "vitest";
import { isRetryableLockError, lockRetryStats } from "@/platform/db/errors";
import type { ConflictError } from "@/shared/errors";
import { bootDealsKit, holdLocks, sqlState, waitForLockWaiters, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

const URL = TEST_DATABASE_URL ?? "";

/**
 * Do not contact and the address triggers against the writers they could deadlock with, on separate connections, through
 * the real code: `setPersonDoNotContact`, `suppressEmail`, `ingestInbound` (reply stop), `createDealFromLead` (conversion) and
 * `skipStep` (run advance). A third connection holds one row (a "gate") to stop a writer at a chosen statement. The rest run at
 * the same moment, many times. No case may lose state. Only the conversion may give way on its 300 ms held-lock timeout, and
 * then its retry succeeds or it answers `try_again`; the reply stop has no retry, so a deadlock would surface there.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("stopContactTx races", () => {
  let kit: DealsKit;
  let deals: typeof import("@/contexts/deals/application/deals");
  let composition: typeof import("@/composition/deals");
  let threads: typeof import("@/contexts/conversations/infrastructure/composition");
  let replyHandling: typeof import("@/contexts/conversations/application/reply-handling");
  let store: typeof import("@/contexts/conversations/infrastructure/drizzle-reply-handling-store").drizzleReplyHandlingStore;
  let runStore: typeof import("@/contexts/conversations/after-reply/infrastructure/drizzle-follow-up-store").drizzleRunStore;
  let suppression: Awaited<ReturnType<typeof import("@/test-support/suppression").suppressionStore>>;

  beforeAll(async () => {
    kit = await bootDealsKit(URL);
    deals = await import("@/contexts/deals/application/deals");
    composition = await import("@/composition/deals");
    threads = await import("@/contexts/conversations/infrastructure/composition");
    replyHandling = await import("@/contexts/conversations/application/reply-handling");
    store = (await import("@/contexts/conversations/infrastructure/drizzle-reply-handling-store")).drizzleReplyHandlingStore;
    runStore = (await import("@/contexts/conversations/after-reply/infrastructure/drizzle-follow-up-store")).drizzleRunStore;
    suppression = await (await import("@/test-support/suppression")).suppressionStore();
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));

  /** A lead with a conversation, an active run on an email thread and a live enrollment. */
  async function leadWithRun(f: DealsOrg) {
    const lead = await f.ingest();
    await f.emailedBy(lead.personId);
    await f.cycle();
    const enrollment = await f.enrollment(await f.campaign(), lead.personId, "active");
    return { ...lead, enrollment };
  }
  type Lead = Awaited<ReturnType<typeof leadWithRun>>;

  const doNotContact = (f: DealsOrg, personId: string) => replyHandling.setPersonDoNotContact({ store, now: () => new Date() } as never, f.owner, personId, { enabled: true, reason: "Asked by phone." });
  const reply = (f: DealsOrg, lead: Lead) => threads.ingestInbound(f.mail({ from: lead.input.from, providerThreadId: lead.input.providerThreadId }));
  const convert = (f: DealsOrg, personId: string) => deals.createDealFromLead(composition.dealsDeps(), f.owner, personId);
  const skip = (f: DealsOrg, lead: Lead) => runStore.skipStep({ organizationId: f.org, conversationId: lead.conversationId, actorUserId: f.owner.userId }, new Date());

  const expectEnded = async (f: DealsOrg, lead: Lead) => {
    expect(await kit.count("contact_policies", f.org, `person_id = '${lead.personId}' and do_not_contact`)).toBe(1);
    expect(await kit.count("campaign_enrollments", f.org, `person_id = '${lead.personId}' and status in ('pending', 'active')`)).toBe(0);
    expect(await kit.count("follow_up_runs", f.org, `conversation_id = '${lead.conversationId}' and status in ('active', 'paused')`)).toBe(0);
  };

  /** What a writer stopped at the conversation must not hold yet: the outreach lock, the enrollment and the run. */
  const holdsNothingElse = async (f: DealsOrg, lead: Lead) => {
    const key = `person-outreach:${f.org}:${lead.personId}`;
    await kit.sql.begin(async (tx) => {
      await tx`set local lock_timeout = '200ms'`;
      const [{ free }] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as free`;
      expect(free).toBe(true);
      await tx`select id from campaign_enrollments where id = ${lead.enrollment} for update nowait`;
      await tx`select id from follow_up_runs where conversation_id = ${lead.conversationId} for update nowait`;
    });
  };

  it("do not contact waits for the conversation before it takes anything else", async () => {
    const f = await kit.organization();
    const lead = await leadWithRun(f);
    const gate = await holdLocks(URL, (tx) => tx`select id from conversations where id = ${lead.conversationId} for no key update`);
    const marking = settle(doNotContact(f, lead.personId));
    await waitForLockWaiters(kit.sql, 1);
    await holdsNothingElse(f, lead);
    // The policy row comes after the conversations too, so clearing the flag or a contact delete cannot meet it first.
    await kit.sql.begin(async (tx) => {
      await tx`set local lock_timeout = '200ms'`;
      const key = `dnc:${lead.personId}`;
      const [{ free }] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as free`;
      expect(free).toBe(true);
    });
    await gate.release();
    const marked = await marking;
    expect(marked.error).toBeNull();
    await expectEnded(f, lead);
  }, 60_000);

  it("an address trigger waits for the conversation before it takes anything else, the suppression row included", async () => {
    const f = await kit.organization();
    const lead = await leadWithRun(f);
    const email = lead.input.from.email.toLowerCase();
    const gate = await holdLocks(URL, (tx) => tx`select id from conversations where id = ${lead.conversationId} for no key update`);
    const suppressing = settle(suppression.suppressEmail({ organizationId: f.org, email, reason: "unsubscribed" }));
    await waitForLockWaiters(kit.sql, 1);
    await holdsNothingElse(f, lead);
    // An uncommitted row under the same unique key would make this insert wait past the timeout.
    const rollback = new Error("rollback");
    await expect(
      kit.sql.begin(async (tx) => {
        await tx`set local lock_timeout = '200ms'`;
        await tx`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${email}, 'manual')`;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await gate.release();
    const suppressed = await suppressing;
    expect(suppressed.error).toBeNull();
    expect(suppressed.value).toEqual({ stopped: 1, added: true });
    expect(await kit.count("follow_up_runs", f.org, `conversation_id = '${lead.conversationId}' and status in ('active', 'paused')`)).toBe(0);
  }, 60_000);

  it.each(["a reply stop", "a conversion"] as const)("%s stopped at the enrollment holds do not contact at the conversation: both commit", async (writer) => {
    const f = await kit.organization();
    const lead = await leadWithRun(f);
    const gate = await holdLocks(URL, (tx) => tx`select id from campaign_enrollments where id = ${lead.enrollment} for update`);
    const first = settle<unknown>(writer === "a reply stop" ? reply(f, lead) : convert(f, lead.personId));
    await waitForLockWaiters(kit.sql, 1);
    const marking = settle(doNotContact(f, lead.personId));
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const [done, marked] = await Promise.all([first, marking]);
    expect(done.error).toBeNull();
    expect(marked.error).toBeNull();
    await expectEnded(f, lead);
  }, 60_000);

  it("a run advance stopped at its step holds do not contact at the conversation: both commit, no retry", async () => {
    const f = await kit.organization();
    const lead = await leadWithRun(f);
    const retries = lockRetryStats.retries;
    const [{ id: step }] = await kit.sql`
      select s.id from follow_up_step_runs s join follow_up_runs r on r.id = s.follow_up_run_id
      where r.conversation_id = ${lead.conversationId} and s.status not in ('sent', 'skipped', 'cancelled', 'failed')
      order by s.created_at limit 1`;
    const gate = await holdLocks(URL, (tx) => tx`select id from follow_up_step_runs where id = ${step} for update`);
    const advancing = settle(skip(f, lead));
    await waitForLockWaiters(kit.sql, 1);
    const marking = settle(doNotContact(f, lead.personId));
    await waitForLockWaiters(kit.sql, 2);
    await gate.release();
    const [advanced, marked] = await Promise.all([advancing, marking]);
    expect(advanced.error).toBeNull();
    expect(marked.error).toBeNull();
    expect(lockRetryStats.retries).toBe(retries);
    await expectEnded(f, lead);
  }, 60_000);

  it("do not contact started at the same moment as a reply, a conversion and a run advance: no deadlock and no lost state, over many people", async () => {
    const f = await kit.organization();
    const leads = await Promise.all(Array.from({ length: 8 }, () => leadWithRun(f)));
    const rounds = await Promise.all(
      leads.map(async (lead) =>
        Promise.all([settle<unknown>(doNotContact(f, lead.personId)), settle<unknown>(reply(f, lead)), settle<unknown>(convert(f, lead.personId)), settle<unknown>(skip(f, lead))]),
      ),
    );
    for (const [marked, replied, converted, skipped] of rounds) {
      expect(marked.error).toBeNull();
      expect(replied.error).toBeNull();
      if (converted.error) expect((converted.error as ConflictError).details?.code).toBe("try_again");
      // A stop that commits first leaves no active run to skip, and that answer is a plain conflict.
      expect(sqlState(skipped.error)).toBeNull();
      expect(isRetryableLockError(skipped.error)).toBe(false);
    }
    for (const lead of leads) await expectEnded(f, lead);
  }, 120_000);
});
