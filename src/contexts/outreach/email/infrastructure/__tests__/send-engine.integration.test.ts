import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { EngineDeps } from "../../application/send-next-email";
import { FakeMailboxProvider } from "../fake-mailbox-provider";
import { MAX_SEND_ATTEMPTS } from "../../../domain/send-policy";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}} at {{company}}", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "", body: "Following up", waitDays: 2 },
];

describeDb("email send engine", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let send: typeof import("../../application/send-next-email");
  let store: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  const cleanup: string[] = [];

  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const clock = { now: () => current };
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  const deps = (provider: FakeMailboxProvider): EngineDeps => ({
    store,
    provider,
    clock,
    random: () => 0, // gap = 18 minutes, first spin option
    appUrl: "https://app.test",
    unsubscribeSecret: "u".repeat(40),
  });

  async function fixture(options: { people?: number; dailyLimit?: number; mailboxes?: number; steps?: unknown[]; campaignStatus?: string } = {}) {
    current = start;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('E', ${"eng-" + tag}) returning id`;
    cleanup.push(org);
    const mailboxIds: string[] = [];
    for (let i = 0; i < (options.mailboxes ?? 1); i++) {
      const [{ id }] = await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, daily_send_limit, working_hours)
        values (${org}, ${`sender${i}-${tag}@corp.test`}, 'Sender', 'connected', ${options.dailyLimit ?? 30}, ${sql.json({ timeZone: "UTC", days: ALL_DAY })})
        returning id`;
      mailboxIds.push(id);
    }
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${org}, 'email', 'c', ${options.campaignStatus ?? "active"}, ${sql.json((options.steps ?? STEPS) as never)}) returning id`;
    const [{ id: company }] = await sql`insert into companies (organization_id, domain, name) values (${org}, ${`acme-${tag}.com`}, 'Acme') returning id`;
    const enrollmentIds: string[] = [];
    const emails: string[] = [];
    for (let i = 0; i < (options.people ?? 1); i++) {
      const email = `lead${i}-${tag}@acme.test`;
      emails.push(email);
      const [{ id: person }] = await sql`
        insert into people (organization_id, email, first_name, company_id, created_at)
        values (${org}, ${email}, ${"Lead" + i}, ${company}, ${new Date(start.getTime() + i * 1000)}) returning id`;
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at)
        values (${org}, ${campaign}, ${person}, 'email', ${new Date(start.getTime() + i * 1000)}) returning id`;
      enrollmentIds.push(enrollment);
    }
    return { org, mailboxIds, campaign, enrollmentIds, emails };
  }

  const enrollment = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  /** Fails the organization's open sends, so a later reconcile in this file does not count them. */
  const settleOpenSends = async (org: string) => {
    await sql`update sends set status = 'failed', attempt = 3 where organization_id = ${org} and status in ('sending', 'unknown')`;
  };
  const sendRows = async (id: string) => await sql`select * from sends where enrollment_id = ${id} order by step_number, claimed_at`;

  beforeAll(async () => {
    send = await import("../../application/send-next-email");
    ({ drizzleOutreachStore: store } = await import("../drizzle-outreach-store"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("sends the first step, renders merge fields and the unsubscribe link, and schedules the follow-up", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    const outcome = await send.sendNextEmail(deps(provider), f.mailboxIds[0]);
    expect(outcome.kind).toBe("sent");

    const mail = provider.delivered[0];
    expect(mail.to).toBe(f.emails[0]);
    expect(mail.subject).toBe("Hi Lead0");
    expect(mail.bodyText).toContain("Hello Lead0 at Acme");
    expect(mail.bodyText).toMatch(/Unsubscribe: https:\/\/app\.test\/unsubscribe\?token=/);
    // RFC 8058: the header targets the POST endpoint, the body link stays the human page.
    expect(mail.listUnsubscribeUrl).toMatch(/^https:\/\/app\.test\/api\/outreach\/unsubscribe\?token=/);
    expect(mail.rfcMessageId).toMatch(/^<[0-9a-f-]+@corp\.test>$/);

    const e = await enrollment(f.enrollmentIds[0]);
    expect(e.status).toBe("active");
    expect(e.current_step).toBe(1);
    expect(new Date(e.next_send_at).toISOString()).toBe("2026-10-16T10:00:00.000Z");
    expect(e.mailbox_id).toBe(f.mailboxIds[0]);
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row).toMatchObject({ status: "sent", attempt: 1, subject: "Hi Lead0" });
  });

  it("keeps the gap between sends, then continues once it has passed", async () => {
    const f = await fixture({ people: 2 });
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    advance(17);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    advance(1);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    expect(provider.delivered.map((m) => m.to)).toEqual([f.emails[0], f.emails[1]]);
  });

  it("reads the gap from the organization's email rules", async () => {
    const f = await fixture({ people: 3 });
    await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'email', ${sql.json({ sendGapMinutes: [5, 5] })})`;
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    advance(4);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    advance(1);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    // A value outside the allowed range falls back to the default of 18 minutes.
    await sql`update channel_settings set values = ${sql.json({ sendGapMinutes: [0, 999] })} where organization_id = ${f.org} and channel = 'email'`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0]))).toMatchObject({ kind: "idle" });
    advance(5);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    const [{ next_send_at }] = await sql`select next_send_at from mailboxes where id = ${f.mailboxIds[0]}`;
    expect((new Date(next_send_at).getTime() - current.getTime()) / 60_000).toBe(18);
  });

  it("stops at the daily limit and resumes the next local day", async () => {
    const f = await fixture({ people: 3, dailyLimit: 2 });
    const provider = new FakeMailboxProvider();
    for (let i = 0; i < 2; i++) {
      expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
      advance(30);
    }
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    advance(14 * 60); // 11:00 next day UTC
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    expect(provider.delivered).toHaveLength(3);
  });

  it("counts sends with an unknown outcome toward the daily limit", async () => {
    const f = await fixture({ people: 3, dailyLimit: 2 });
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "timeout-lost";
    for (let i = 0; i < 2; i++) {
      expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("unknown");
      advance(30);
    }
    provider.behavior = () => "ok";
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    expect(provider.delivered).toHaveLength(0);
    await settleOpenSends(f.org);
  });

  it("counts a claim still sending toward the daily limit", async () => {
    const f = await fixture({ people: 2, dailyLimit: 1 });
    await sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, attempt, claimed_at)
      values (${f.org}, ${f.enrollmentIds[0]}, 1, 'email', 'sending', ${f.mailboxIds[0]}, 1, ${start})`;
    const provider = new FakeMailboxProvider();
    advance(5);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    expect(provider.delivered).toHaveLength(0);
    await settleOpenSends(f.org);
  });

  it("does not count test sends toward the daily limit", async () => {
    const f = await fixture({ people: 1, dailyLimit: 2 });
    for (let i = 0; i < 2; i++) {
      await sql`
        insert into sends (organization_id, kind, channel, status, mailbox_id, to_address, claimed_at)
        values (${f.org}, 'test', 'email', 'sent', ${f.mailboxIds[0]}, ${`me${i}@corp.test`}, ${start})`;
    }
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
  });

  it("starts the daily limit day in the mailbox's working-hours zone", async () => {
    const f = await fixture({ people: 2, dailyLimit: 1 });
    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "Asia/Seoul", days: ALL_DAY })} where id = ${f.mailboxIds[0]}`;
    const provider = new FakeMailboxProvider();
    current = new Date("2026-10-14T23:30:00Z"); // 08:30 on Oct 15 in Seoul
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    advance(60); // a new UTC day, the same Seoul day
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    current = new Date("2026-10-15T15:00:00Z"); // midnight on Oct 16 in Seoul
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
  });

  it("sends the follow-up in the same thread before starting new leads", async () => {
    const f = await fixture({ people: 2 });
    const provider = new FakeMailboxProvider();
    await send.sendNextEmail(deps(provider), f.mailboxIds[0]); // lead 0, step 1
    advance(2 * 24 * 60); // follow-up is due
    const outcome = await send.sendNextEmail(deps(provider), f.mailboxIds[0]);
    expect(outcome.kind).toBe("sent");
    const [first, second] = provider.delivered;
    expect(second.to).toBe(first.to); // the follow-up, not lead 1
    expect(second.subject).toBe("Re: Hi Lead0");
    expect(second.inReplyTo).toBe(first.rfcMessageId);
    expect(second.references).toEqual([first.rfcMessageId]);
    const e = await enrollment(f.enrollmentIds[0]);
    expect(e.status).toBe("completed");
    expect(e.next_send_at).toBeNull();
  });

  it("sends once when the same mailbox is claimed by two workers at the same time", async () => {
    const f = await fixture({ people: 3 });
    const provider = new FakeMailboxProvider();
    const results = await Promise.all([1, 2, 3, 4].map(() => send.sendNextEmail(deps(provider), f.mailboxIds[0])));
    expect(results.filter((r) => r.kind === "sent")).toHaveLength(1);
    expect(provider.delivered).toHaveLength(1);
  });

  it("never gives one lead to two mailboxes", async () => {
    const f = await fixture({ people: 2, mailboxes: 2 });
    const provider = new FakeMailboxProvider();
    const results = await Promise.all(f.mailboxIds.map((id) => send.sendNextEmail(deps(provider), id)));
    expect(results.every((r) => r.kind === "sent")).toBe(true);
    expect(new Set(provider.delivered.map((m) => m.to)).size).toBe(2);
    const [{ count }] = await sql`select count(*)::int as count from sends where organization_id = ${f.org}`;
    expect(count).toBe(2);
  });

  it("retries a refused send with backoff and gives up after three attempts", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "refuse";
    const d = deps(provider);

    expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "failed", retry: true });
    let e = await enrollment(f.enrollmentIds[0]);
    expect(new Date(e.next_send_at).toISOString()).toBe("2026-10-14T10:15:00.000Z");
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle"); // gap and backoff still apply

    advance(30);
    expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "failed", retry: true });
    advance(60);
    expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "failed", retry: false });

    e = await enrollment(f.enrollmentIds[0]);
    expect(e.status).toBe("failed");
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row).toMatchObject({ status: "failed", attempt: 3 });
    advance(24 * 60);
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle");
    expect(provider.delivered).toHaveLength(0);
  });

  // Migration 0004 took the cap out of the sends trigger, so these two tests are what holds it.
  describe("the attempt cap", () => {
    it("is three attempts", () => {
      expect(MAX_SEND_ATTEMPTS).toBe(3);
    });

    it("calls the provider at most MAX_SEND_ATTEMPTS times for one step, then ends the enrollment failed", async () => {
      const f = await fixture();
      const provider = new FakeMailboxProvider();
      let calls = 0;
      provider.behavior = () => {
        calls += 1;
        return "refuse";
      };
      const d = deps(provider);

      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "failed", retry: attempt < MAX_SEND_ATTEMPTS });
        expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt, error: "Recipient address rejected" });
        advance(24 * 60);
      }
      expect(calls).toBe(MAX_SEND_ATTEMPTS);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed", stop_reason: "send_failed: Recipient address rejected", next_send_at: null, current_step: 0 });

      // A provider that would now accept is never asked again.
      provider.behavior = () => {
        calls += 1;
        return "ok";
      };
      for (let i = 0; i < 3; i++) {
        expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle");
        advance(24 * 60);
      }
      expect(calls).toBe(MAX_SEND_ATTEMPTS);
      expect(await sendRows(f.enrollmentIds[0])).toHaveLength(1);
      expect(provider.delivered).toHaveLength(0);
    });

    it("takes the cap from the enrollment's retry decision, so a cap of four allows four calls", async () => {
      const f = await fixture();
      const provider = new FakeMailboxProvider();
      let calls = 0;
      provider.behavior = () => {
        calls += 1;
        return "refuse";
      };
      const four: typeof store = { ...store, markFailed: (claim, error, now, retry) => store.markFailed(claim, error, now, retry, 4) };
      const d = { ...deps(provider), store: four };

      for (let attempt = 1; attempt <= 4; attempt++) {
        expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("failed");
        expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt });
        advance(24 * 60);
      }
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed", stop_reason: "send_failed: Recipient address rejected" });
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle");
      expect(calls).toBe(4);
    });

    it("ignores a stale reconciler result that lands on a later attempt of the same step", async () => {
      const { resolveUnknownEmailSend } = await import("../drizzle-outreach-store");
      const f = await fixture();
      const provider = new FakeMailboxProvider();
      let calls = 0;
      const d = deps(provider);

      // Attempt 1 fails; attempt 2 ends unknown.
      provider.behavior = () => (++calls === 1 ? "refuse" : "timeout-lost");
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("failed");
      advance(60);
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("unknown");

      // A reconciler reads attempt 2 and stalls. A person marks it not delivered meanwhile.
      advance(11);
      const stale = (await store.listUncertain(current, 500)).find((u) => u.enrollmentId === f.enrollmentIds[0])!;
      expect(stale).toMatchObject({ attempt: 2 });
      const resolved = await resolveUnknownEmailSend({
        organizationId: f.org, campaignId: f.campaign, sendId: stale.sendId, outcome: "not_delivered",
        actorUserId: "00000000-0000-4000-8000-000000000000", now: current, retryDelayMinutes: () => 15, maxAttempts: MAX_SEND_ATTEMPTS,
      });
      expect(resolved).toBe("resolved");

      // Attempt 3 is claimed and in flight when the stale results land. Neither changes it.
      advance(60);
      const third = await store.claimNext({ mailboxId: f.mailboxIds[0], now: current, pickGapMinutes: () => 18, takeoverAfterHours: () => 24, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }) });
      expect(third).toMatchObject({ sendId: stale.sendId, attempt: 3 });
      await store.resolveUncertainAsNotSent(stale, current, 15, MAX_SEND_ATTEMPTS);
      await store.resolveUncertainAsSent(stale, { providerMessageId: "stale", threadId: "stale" }, current);
      expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "sending", attempt: 3 });

      // Attempt 3's own failure ends the enrollment at the cap, and no fourth claim follows.
      await store.markFailed(third!, "Recipient address rejected", current, 45, MAX_SEND_ATTEMPTS);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed" });
      advance(24 * 60);
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle");
    });

    it("counts a lost send the reconciler proves absent as an attempt toward the same cap", async () => {
      const f = await fixture();
      const provider = new FakeMailboxProvider();
      const d = deps(provider);

      // Attempt 1 is lost and comes back as not sent after the grace period.
      provider.behavior = () => "timeout-lost";
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("unknown");
      advance(11);
      await send.reconcileUncertainSends(d);
      advance(30);
      expect(await send.reconcileUncertainSends(d)).toMatchObject({ retryable: 1 });
      expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt: 1 });
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending" });

      // The rest are refused. Only MAX_SEND_ATTEMPTS - 1 more calls happen.
      provider.behavior = () => "refuse";
      for (let attempt = 2; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        advance(60);
        expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "failed", retry: attempt < MAX_SEND_ATTEMPTS });
      }
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed", stop_reason: "send_failed: Recipient address rejected" });
      expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt: MAX_SEND_ATTEMPTS });
      provider.behavior = () => "ok";
      advance(24 * 60);
      expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle");
    });
  });

  it("never retries an uncertain send by itself, and settles it from the mailbox when it was delivered", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "timeout-after-accept";
    const d = deps(provider);

    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("unknown");
    advance(60);
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle"); // not resent
    expect(provider.delivered).toHaveLength(1);

    const report = await send.reconcileUncertainSends(d);
    expect(report).toMatchObject({ foundSent: 1, retryable: 0 });
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row.status).toBe("sent");
    const e = await enrollment(f.enrollmentIds[0]);
    expect(e).toMatchObject({ status: "active", current_step: 1 });
    expect(provider.delivered).toHaveLength(1);
  });

  it("waits out the grace period before treating a missing message as unsent, then retries once", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "timeout-lost";
    const d = deps(provider);
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("unknown");

    advance(11);
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ stillWaiting: 1, retryable: 0 });
    provider.findFails = true;
    advance(30);
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ stillWaiting: 1 }); // an outage is not proof
    provider.findFails = false;
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ retryable: 1 });

    provider.behavior = () => "ok";
    advance(60);
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("sent");
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row).toMatchObject({ status: "sent", attempt: 2 });
    expect(provider.delivered).toHaveLength(1);
  });

  it("keeps an inconclusive lookup unknown and retries only once the mailbox proves absence", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "timeout-lost";
    const d = deps(provider);
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("unknown");

    provider.findInconclusive = "scan hit its page cap";
    advance(60);
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ inconclusive: 1, retryable: 0, foundSent: 0 });
    advance(24 * 60);
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ inconclusive: 1, retryable: 0 });
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row.status).toBe("unknown");
    provider.behavior = () => "ok";
    expect((await send.sendNextEmail(d, f.mailboxIds[0])).kind).toBe("idle"); // still blocked, never resent
    expect(provider.delivered).toHaveLength(0);

    provider.findInconclusive = null;
    expect(await send.reconcileUncertainSends(d)).toMatchObject({ retryable: 1, inconclusive: 0 });
  });

  it("recovers a claim that crashed before rendering", async () => {
    const f = await fixture();
    // A claim written and then abandoned by a dead worker.
    await sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, attempt, claimed_at)
      values (${f.org}, ${f.enrollmentIds[0]}, 1, 'email', 'sending', ${f.mailboxIds[0]}, 1, ${start})`;
    const provider = new FakeMailboxProvider();
    advance(15);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle"); // the claim blocks the step
    expect(await send.reconcileUncertainSends(deps(provider))).toMatchObject({ retryable: 1 });
    advance(30);
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
  });

  it("blocks suppressed addresses and do-not-contact people after the claim and before the provider", async () => {
    const f = await fixture({ people: 2 });
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${f.emails[0]}, 'unsubscribed')`;
    const [{ id: person1 }] = await sql`select id from people where organization_id = ${f.org} and email = ${f.emails[1]}`;
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${person1}, ${f.org}, true, 'human', now())`;
    const provider = new FakeMailboxProvider();
    const d = deps(provider);

    expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "blocked", reason: "suppressed" });
    advance(30);
    expect(await send.sendNextEmail(d, f.mailboxIds[0])).toEqual({ kind: "blocked", reason: "do_not_contact" });
    expect(provider.delivered).toHaveLength(0);
    for (const id of f.enrollmentIds) expect(await enrollment(id)).toMatchObject({ status: "suppressed", next_send_at: null });
  });

  it("does not send for a paused campaign", async () => {
    const f = await fixture({ campaignStatus: "paused" });
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
  });

  it("returns the attempt when a campaign is paused between claim and send", async () => {
    const f = await fixture();
    const claim = await store.claimNext({ mailboxId: f.mailboxIds[0], now: current, pickGapMinutes: () => 18, takeoverAfterHours: () => 24, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }) });
    expect(claim).not.toBeNull();
    await sql`update campaigns set status = 'paused' where id = ${f.campaign}`;
    expect(await store.checkBlockers(claim!)).toBe("campaign_inactive");
    await store.abandon(claim!, "campaign_inactive", current);
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row).toMatchObject({ status: "failed", attempt: 0 });
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("pending");

    await sql`update campaigns set status = 'active' where id = ${f.campaign}`;
    advance(30);
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
  });

  describe("an enrollment that stops between claim and send", () => {
    const claimFor = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const claim = await store.claimNext({ mailboxId: f.mailboxIds[0], now: current, pickGapMinutes: () => 18, takeoverAfterHours: () => 24, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }) });
      expect(claim).not.toBeNull();
      return claim!;
    };

    it("blocks the send after a reply and keeps the replied status", async () => {
      const f = await fixture();
      const claim = await claimFor(f);
      await sql`update campaign_enrollments set status = 'replied', next_send_at = null, stop_reason = 'replied' where id = ${f.enrollmentIds[0]}`;
      expect(await store.checkBlockers(claim)).toBe("enrollment_stopped");
      await store.abandon(claim, "enrollment_stopped", current);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", stop_reason: "replied" });
      // Nothing reached the provider, so the claim gives its attempt back.
      const [row] = await sendRows(f.enrollmentIds[0]);
      expect(row).toMatchObject({ status: "failed", attempt: 0 });
    });

    it("blocks the send after an unsubscribe and keeps the suppressed status", async () => {
      const f = await fixture();
      const claim = await claimFor(f);
      const drizzleSuppressionStore = await (await import("@/test-support/suppression")).suppressionStore();
      await drizzleSuppressionStore.suppressEmail({ organizationId: f.org, email: f.emails[0], reason: "unsubscribed" });
      expect(await store.checkBlockers(claim)).toBe("enrollment_stopped");
      await store.abandon(claim, "enrollment_stopped", current);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "suppressed", stop_reason: "unsubscribed" });
    });

    it("records a late send as sent without resurrecting the enrollment", async () => {
      const f = await fixture();
      const claim = await claimFor(f);
      await sql`update campaign_enrollments set status = 'replied', next_send_at = null, stop_reason = 'replied' where id = ${f.enrollmentIds[0]}`;
      advance(1);
      await store.markSent(claim, { providerMessageId: "late-1", threadId: "late-thread" }, current);
      const [row] = await sendRows(f.enrollmentIds[0]);
      expect(row).toMatchObject({ status: "sent", provider_message_id: "late-1" });
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", current_step: 0, next_send_at: null });
    });

    it("does not let a late failure turn a stopped enrollment into failed", async () => {
      const f = await fixture();
      const claim = await claimFor(f);
      await sql`update campaign_enrollments set status = 'bounced', next_send_at = null, stop_reason = 'bounced' where id = ${f.enrollmentIds[0]}`;
      await store.markFailed(claim, "boom", current, 10, claim.attempt);
      expect((await enrollment(f.enrollmentIds[0])).status).toBe("bounced");
    });
  });

  it("honors a campaign's sender pool", async () => {
    const f = await fixture({ people: 1, mailboxes: 2 });
    await sql`insert into campaign_senders (organization_id, campaign_id, mailbox_id) values (${f.org}, ${f.campaign}, ${f.mailboxIds[1]})`;
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[1])).kind).toBe("sent");
  });

  it("keeps organizations apart", async () => {
    const a = await fixture({ people: 1 });
    const b = await fixture({ people: 0 });
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), b.mailboxIds[0])).kind).toBe("idle");
    expect((await send.sendNextEmail(deps(provider), a.mailboxIds[0])).kind).toBe("sent");
    expect(provider.delivered[0].mailbox.emailAddress).toBe((await sql`select email_address from mailboxes where id = ${a.mailboxIds[0]}`)[0].email_address);
  });

  it("stops an address's sequences when it unsubscribes, and nothing else", async () => {
    const f = await fixture({ people: 2 });
    const drizzleSuppressionStore = await (await import("@/test-support/suppression")).suppressionStore();
    const provider = new FakeMailboxProvider();
    await send.sendNextEmail(deps(provider), f.mailboxIds[0]); // lead 0 is now active
    // Suppression blocks email only: lead 0's LinkedIn sequence keeps running.
    const [{ id: person0 }] = await sql`update people set linkedin_slug = ${"lead0-" + f.org} where organization_id = ${f.org} and email = ${f.emails[0]} returning id`;
    const [{ id: linkedinCampaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${f.org}, 'linkedin', 'li', 'active', ${sql.json([{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }] as never)}) returning id`;
    const [{ id: linkedinEnrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step)
      values (${f.org}, ${linkedinCampaign}, ${person0}, 'linkedin', 'active', 1) returning id`;

    const first = await drizzleSuppressionStore.suppressEmail({ organizationId: f.org, email: ` ${f.emails[0].toUpperCase()} `, reason: "unsubscribed" });
    expect(first.stopped).toBe(1);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "suppressed", next_send_at: null, stop_reason: "unsubscribed" });
    expect((await enrollment(f.enrollmentIds[1])).status).toBe("pending");
    expect(await enrollment(linkedinEnrollment)).toMatchObject({ status: "active", stop_reason: null });

    const again = await drizzleSuppressionStore.suppressEmail({ organizationId: f.org, email: f.emails[0], reason: "unsubscribed" });
    expect(again.stopped).toBe(0); // idempotent
    const [{ count }] = await sql`select count(*)::int as count from suppression_list where organization_id = ${f.org}`;
    expect(count).toBe(1);

    advance(60 * 24 * 3);
    const outcome = await send.sendNextEmail(deps(provider), f.mailboxIds[0]);
    expect(outcome.kind).toBe("sent");
    expect(provider.delivered.map((m) => m.to)).toEqual([f.emails[0], f.emails[1]]); // lead 1 only; no follow-up to lead 0
  });

  it("does not suppress the same address in another organization", async () => {
    const a = await fixture({ people: 0 });
    const b = await fixture({ people: 1 });
    await sql`update people set email = 'shared@x.test' where organization_id = ${b.org}`;
    const drizzleSuppressionStore = await (await import("@/test-support/suppression")).suppressionStore();
    await drizzleSuppressionStore.suppressEmail({ organizationId: a.org, email: "shared@x.test", reason: "unsubscribed" });
    const rows = await sql`select organization_id from suppression_list where email = 'shared@x.test'`;
    expect(rows.map((r) => r.organization_id)).toEqual([a.org]);
    expect(b.org).not.toBe(a.org);
    // Organization B still mails the address.
    const provider = new FakeMailboxProvider();
    expect((await send.sendNextEmail(deps(provider), b.mailboxIds[0])).kind).toBe("sent");
    expect(provider.delivered.map((m) => m.to)).toEqual(["shared@x.test"]);
    expect(await enrollment(b.enrollmentIds[0])).toMatchObject({ status: "active" });
  });

  it("does not send outside working hours", async () => {
    const f = await fixture();
    await sql`update mailboxes set working_hours = ${sql.json({ timeZone: "UTC", days: { "1": [{ start: "09:00", end: "18:00" }] } })} where id = ${f.mailboxIds[0]}`;
    const provider = new FakeMailboxProvider();
    // The fixture clock is a Wednesday and the window is Monday only.
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
  });

  /** Runs `fn` with PAUSE_OUTBOUND set to `value` and restores the previous value. */
  async function withPause<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const before = process.env.PAUSE_OUTBOUND;
    if (value === undefined) delete process.env.PAUSE_OUTBOUND;
    else process.env.PAUSE_OUTBOUND = value;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.PAUSE_OUTBOUND;
      else process.env.PAUSE_OUTBOUND = before;
    }
  }

  it("claims nothing while PAUSE_OUTBOUND is set and sends once it is unset", async () => {
    const f = await fixture({ people: 2 });
    const provider = new FakeMailboxProvider();
    await withPause("true", async () => {
      expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
      advance(60);
      expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    });
    expect(provider.delivered).toHaveLength(0);
    const [{ n }] = await sql`select count(*)::int as n from sends where organization_id = ${f.org}`;
    expect(n).toBe(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending", next_send_at: null });

    for (const off of [undefined, "false", "off"]) {
      const g = await fixture();
      const resumed = await withPause(off, () => send.sendNextEmail(deps(new FakeMailboxProvider()), g.mailboxIds[0]));
      expect(resumed.kind).toBe("sent");
    }
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
    expect(provider.delivered).toHaveLength(1);
  });

  it("claims nothing while the organization paused sending, and sends once it resumes", async () => {
    const f = await fixture();
    const other = await fixture();
    const provider = new FakeMailboxProvider();
    await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ sendingPaused: { at: "2026-01-01T00:00:00.000Z", byName: "Ada" } })})
      on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("idle");
    // The pause belongs to one organization: another one keeps sending.
    expect((await send.sendNextEmail(deps(provider), other.mailboxIds[0])).kind).toBe("sent");
    const [{ n }] = await sql`select count(*)::int as n from sends where organization_id = ${f.org}`;
    expect(n).toBe(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending" });

    await sql`update channel_settings set values = values || ${sql.json({ sendingPaused: null })} where organization_id = ${f.org} and channel = 'general'`;
    expect((await send.sendNextEmail(deps(provider), f.mailboxIds[0])).kind).toBe("sent");
  });
});
