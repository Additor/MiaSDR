import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { InboundStore } from "../../../application/inbound-ports";
import type { InboxDeps } from "../../application/sync-inbox";
import type { EngineDeps } from "../../application/send-next-email";
import { FakeMailboxProvider } from "../fake-mailbox-provider";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "", body: "Following up", waitDays: 2 },
];

const GMAIL_AUTH =
  "mx.google.com; dkim=pass header.i=@googlemail.com header.s=20230601 header.b=AbCdEf12; spf=pass (google.com: domain of mailer-daemon@googlemail.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=mailer-daemon@googlemail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=googlemail.com";
const authHeaders = { "authentication-results": GMAIL_AUTH };

describeDb("inbound mail sync", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let send: typeof import("../../application/send-next-email");
  let sync: typeof import("../../application/sync-inbox");
  let jobs: typeof import("../../application/inbox-jobs");
  let outreachStore: EngineDeps["store"];
  let inboundStore: InboundStore;
  const cleanup: string[] = [];

  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const clock = { now: () => current };
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  const engine = (provider: FakeMailboxProvider): EngineDeps => ({
    store: outreachStore,
    provider,
    clock,
    random: () => 0,
    appUrl: "https://app.test",
    unsubscribeSecret: "u".repeat(40),
  });
  const inbox = (provider: FakeMailboxProvider, store: InboundStore = inboundStore): InboxDeps => ({ store, provider, clock, minIntervalSeconds: 0 });

  async function fixture(people = 1) {
    current = start;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('I', ${"inb-" + tag}) returning id`;
    cleanup.push(org);
    const address = `sender-${tag}@corp.test`;
    const [{ id: mailbox }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status, working_hours)
      values (${org}, ${address}, 'Sender', 'connected', ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${org}, 'email', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const enrollmentIds: string[] = [];
    const emails: string[] = [];
    for (let i = 0; i < people; i++) {
      const email = `lead${i}-${tag}@acme.test`;
      emails.push(email);
      const [{ id: person }] = await sql`
        insert into people (organization_id, email, first_name, created_at)
        values (${org}, ${email}, ${"Lead" + i}, ${new Date(start.getTime() + i * 1000)}) returning id`;
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at)
        values (${org}, ${campaign}, ${person}, 'email', ${new Date(start.getTime() + i * 1000)}) returning id`;
      enrollmentIds.push(enrollment);
    }
    return { org, mailbox, address, enrollmentIds, emails };
  }

  /** Sends step 1 to every lead and takes the first sync, so later deliveries are picked up. */
  async function sentFixture(people = 1) {
    const f = await fixture(people);
    const provider = new FakeMailboxProvider();
    for (let i = 0; i < people; i++) {
      expect((await send.sendNextEmail(engine(provider), f.mailbox)).kind).toBe("sent");
      advance(30);
    }
    await sync.syncMailboxInbox(inbox(provider), f.mailbox);
    return { ...f, provider };
  }

  const enrollment = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const inboxMessages = async (org: string) => await sql`select * from messages where organization_id = ${org} order by sent_at`;
  const mailboxRow = async (id: string) => (await sql`select * from mailboxes where id = ${id}`)[0];
  const sendRow = async (enrollmentId: string) => (await sql`select * from sends where enrollment_id = ${enrollmentId} order by step_number`)[0];
  const suppressed = async (org: string, email: string) => await sql`select * from suppression_list where organization_id = ${org} and email = ${email}`;

  beforeAll(async () => {
    send = await import("../../application/send-next-email");
    sync = await import("../../application/sync-inbox");
    jobs = await import("../../application/inbox-jobs");
    ({ drizzleOutreachStore: outreachStore } = await import("../drizzle-outreach-store"));
    inboundStore = (await import("../drizzle-inbound-store")).createDrizzleInboundStore((await import("@/composition/inbox-filing")).inboxFiling, (await import("@/composition/inbox-filing")).followUps);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("ingests nothing on the first sync and stores the cursor", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null } });
    const outcome = await sync.syncMailboxInbox(inbox(provider), f.mailbox);
    expect(outcome).toEqual({ kind: "synced", counts: {}, reset: false });
    const row = await mailboxRow(f.mailbox);
    expect(row.gmail_history_cursor).not.toBeNull();
    expect(row.last_synced_at).not.toBeNull();
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("pending");
  });

  it("a reply matched by send id stops the sequence and no follow-up goes out", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: row.id });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { reply: 1 } });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", next_send_at: null, stop_reason: "replied" });

    advance(60 * 24 * 5);
    expect((await send.sendNextEmail(engine(f.provider), f.mailbox)).kind).toBe("idle");
    expect(f.provider.delivered).toHaveLength(1);
  });

  it("matches a reply by In-Reply-To and by thread id", async () => {
    const f = await sentFixture(2);
    const first = f.provider.delivered[0];
    const second = await sendRow(f.enrollmentIds[1]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, inReplyTo: first.rfcMessageId });
    f.provider.deliverInbound(f.address, { from: { email: f.emails[1], name: null }, threadId: second.thread_id });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { reply: 2 } });
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("replied");
    expect((await enrollment(f.enrollmentIds[1])).status).toBe("replied");
  });

  it("matches through the References header without angle brackets", async () => {
    const f = await sentFixture();
    const id = f.provider.delivered[0].rfcMessageId.replace(/^<|>$/g, "");
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, references: ["<unrelated@x.test>", id] });
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("replied");
  });

  it("an auto-reply does not stop the sequence", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    const before = await enrollment(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: row.id, headers: { "auto-submitted": "auto-replied" }, subject: "Automatic reply: Hi" });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { auto_reply: 1 } });
    const after = await enrollment(f.enrollmentIds[0]);
    expect(after.status).toBe("active");
    expect(after.next_send_at).toEqual(before.next_send_at);

    advance(60 * 24 * 3);
    expect((await send.sendNextEmail(engine(f.provider), f.mailbox)).kind).toBe("sent");
  });

  it("stores a message from an unknown sender in the inbox and leaves the sequence alone", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, { from: { email: "stranger@elsewhere.test", name: "Sam Stranger" } });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { unmatched_message: 1 } });
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("active");
    expect(await sql`select source from people where organization_id = ${f.org} and email = 'stranger@elsewhere.test'`).toEqual([{ source: "inbound" }]);
    expect(await inboxMessages(f.org)).toMatchObject([{ from_address: "stranger@elsewhere.test", important: false }]);
  });

  it("stores a matched reply under the lead who was enrolled, once, even when the batch replays", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: row.id, threadId: row.thread_id });
    const cursorBefore = (await mailboxRow(f.mailbox)).gmail_history_cursor;
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    await sql`update mailboxes set gmail_history_cursor = ${cursorBefore} where id = ${f.mailbox}`;
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await inboxMessages(f.org)).toHaveLength(1);
    // The lead already existed, so no second person appears.
    expect(await sql`select id from people where organization_id = ${f.org}`).toHaveLength(1);
    const [conversation] = await sql`select provider_thread_id from conversations where organization_id = ${f.org}`;
    expect(conversation.provider_thread_id).toBe(row.thread_id);
  });

  it("stores an auto-reply flagged, and skips bounces and our own messages", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, headers: { "auto-submitted": "auto-replied" }, subject: "Automatic reply: Hi" });
    f.provider.deliverInbound(f.address, { from: { email: f.address, name: null }, subject: "my own note" });
    f.provider.deliverInbound(f.address, {
      headers: authHeaders,
      from: { email: "mailer-daemon@googlemail.com", name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    const stored = await inboxMessages(f.org);
    expect(stored).toHaveLength(1);
    expect(stored[0].raw).toMatchObject({ autoReply: true });
  });

  it("a hard bounce suppresses the address and bounces its enrollments", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, {
      headers: authHeaders,
      from: { email: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem" },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { hard_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(1);
    expect((await suppressed(f.org, f.emails[0]))[0].reason).toBe("bounced");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "bounced", next_send_at: null });
  });

  it("does not suppress a spoofed bounce for an address we never contacted", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, {
      from: { email: "mailer-daemon@evil.com", name: "Mail Delivery Subsystem" },
      subject: "Delivery Status Notification (Failure)",
      bodyText: "Your message wasn't delivered to ceo@customer.com because the address couldn't be found.",
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { unverified_bounce: 1 } });
    expect(await suppressed(f.org, "ceo@customer.com")).toHaveLength(0);
  });

  it("does not suppress a spoofed bounce for an address we contacted when nothing ties it to our send", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, {
      from: { email: "mailer-daemon@evil.com", name: "Mail Delivery Subsystem" },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { unverified_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("active");
    expect((await inboxMessages(f.org))[0].raw).toMatchObject({ autoReply: true, possibleBounce: true });
  });

  async function forged(headers: Record<string, string>, from = "mailer-daemon@acme.test") {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, {
      headers,
      from: { email: from, name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    return { f, outcome };
  }
  const authFor = (d: string) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=x; spf=pass smtp.mailfrom=mailer-daemon@${d}; dmarc=pass (p=NONE) header.from=${d}`;

  it("does not suppress a forged mailer-daemon on the recipient's domain without authentication, and flags it", async () => {
    const { f, outcome } = await forged({});
    expect(outcome).toMatchObject({ kind: "synced", counts: { unverified_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
    expect((await inboxMessages(f.org))[0].raw).toMatchObject({ autoReply: true, possibleBounce: true });
  });

  it("does not suppress when authentication fails (dmarc=fail)", async () => {
    const { f, outcome } = await forged({ "authentication-results": "mx.google.com; spf=fail smtp.mailfrom=acme.test; dmarc=fail (p=NONE) header.from=acme.test" });
    expect(outcome).toMatchObject({ kind: "synced", counts: { unverified_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
  });

  it("suppresses authenticated delivery-system mail from the recipient's own domain", async () => {
    const { f, outcome } = await forged({ "authentication-results": authFor("acme.test") });
    expect(outcome).toMatchObject({ kind: "synced", counts: { hard_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(1);
  });

  it("ignores an Authentication-Results copy the sender injected", async () => {
    const { f, outcome } = await forged({ "authentication-results": "mx.acme.test; dmarc=pass header.from=acme.test" });
    expect(outcome).toMatchObject({ kind: "synced", counts: { unverified_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
  });

  it("does not suppress a bounce for an address that only another mailbox contacted", async () => {
    const f = await sentFixture();
    const [{ id: other }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status)
      values (${f.org}, ${"other-" + f.address}, 'Other', 'connected') returning id`;
    const otherAddress = (await mailboxRow(other)).email_address;
    f.provider.deliverInbound(otherAddress, {
      from: { email: "mailer-daemon@googlemail.com", name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    await sync.syncMailboxInbox(inbox(f.provider), other);
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
  });

  it("suppresses a bounce from a foreign sender that carries our send id", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, {
      from: { email: "mailer-daemon@relay.example.net", name: null },
      subject: "Undeliverable: Hi Lead0",
      sendId: row.id,
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { hard_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(1);
  });

  it("a soft bounce records nothing against the lead", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, {
      from: { email: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem" },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]}. The mailbox is full, try again later.`,
    });
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { soft_bounce: 1 } });
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("active");
  });

  it("guards: a bounce for our own mailbox is no bounce, and one from the failed recipient is a human reply", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, {
      from: { email: "mailer-daemon@googlemail.com", name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.address} because it is full.`,
    });
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await suppressed(f.org, f.address)).toHaveLength(0);
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("active");

    f.provider.deliverInbound(f.address, {
      from: { email: f.emails[0], name: null },
      subject: "Re: Hi",
      sendId: row.id,
      headers: { "content-type": "multipart/report; report-type=delivery-status" },
      bodyText: `Your message wasn't delivered to ${f.emails[0]}, but this is me typing.`,
    });
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(0);
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("replied");
  });

  it("a bounce does not touch another organization that has the same address", async () => {
    const a = await sentFixture();
    const b = await fixture();
    await sql`update people set email = ${a.emails[0]} where organization_id = ${b.org}`;
    a.provider.deliverInbound(a.address, {
      headers: authHeaders,
      from: { email: "mailer-daemon@googlemail.com", name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${a.emails[0]} because the address couldn't be found.`,
    });
    await sync.syncMailboxInbox(inbox(a.provider), a.mailbox);
    expect(await suppressed(b.org, a.emails[0])).toHaveLength(0);
    expect((await enrollment(b.enrollmentIds[0])).status).toBe("pending");
  });

  it("handles a re-delivered batch without changing the result", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: row.id });
    f.provider.deliverInbound(f.address, {
      headers: authHeaders,
      from: { email: "mailer-daemon@googlemail.com", name: null },
      subject: "Delivery Status Notification (Failure)",
      bodyText: `Your message wasn't delivered to ${f.emails[0]} because the address couldn't be found.`,
    });
    const cursorBefore = (await mailboxRow(f.mailbox)).gmail_history_cursor;
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    const afterFirst = await enrollment(f.enrollmentIds[0]);
    await sql`update mailboxes set gmail_history_cursor = ${cursorBefore} where id = ${f.mailbox}`;
    const second = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(second.kind).toBe("synced");
    expect(await enrollment(f.enrollmentIds[0])).toEqual(afterFirst);
    expect(await suppressed(f.org, f.emails[0])).toHaveLength(1);
  });

  it("keeps the cursor when one message fails, records the error, and replays the batch next time", async () => {
    const f = await sentFixture(2);
    const first = await sendRow(f.enrollmentIds[0]);
    const second = await sendRow(f.enrollmentIds[1]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: first.id });
    f.provider.deliverInbound(f.address, { from: { email: f.emails[1], name: null }, sendId: second.id, subject: "poison" });
    const cursorBefore = (await mailboxRow(f.mailbox)).gmail_history_cursor;

    const flaky: InboundStore = {
      ...inboundStore,
      async applyInbound(mailbox, email, classification, now) {
        if (email.subject === "poison") throw new Error("database went away");
        return inboundStore.applyInbound(mailbox, email, classification, now);
      },
    };
    const outcome = await sync.syncMailboxInbox(inbox(f.provider, flaky), f.mailbox);
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("database went away") });
    const row = await mailboxRow(f.mailbox);
    expect(row.gmail_history_cursor).toBe(cursorBefore);
    expect(row.last_error).toContain("database went away");
    expect(row.last_error).toContain("attempt 1 of 5");
    expect(row.status).toBe("connected");

    const retry = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(retry).toMatchObject({ kind: "synced", counts: { reply: 2 } });
    const healed = await mailboxRow(f.mailbox);
    expect(healed.gmail_history_cursor).not.toBe(cursorBefore);
    expect(healed.last_error).toBeNull();
  });

  describe("dead letter", () => {
    async function poisoned() {
      const f = await sentFixture(2);
      const first = await sendRow(f.enrollmentIds[0]);
      const second = await sendRow(f.enrollmentIds[1]);
      f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: first.id, subject: "poison" });
      f.provider.deliverInbound(f.address, { from: { email: f.emails[1], name: null }, sendId: second.id });
      const cursorBefore = (await mailboxRow(f.mailbox)).gmail_history_cursor;
      let calls = 0;
      const flaky: InboundStore = {
        ...inboundStore,
        async applyInbound(mailbox, email, classification, now) {
          if (email.subject === "poison") {
            calls += 1;
            throw new Error("constraint violation");
          }
          return inboundStore.applyInbound(mailbox, email, classification, now);
        },
      };
      const events = async () => await sql`select * from inbound_events where organization_id = ${f.org}`;
      return { f, flaky, cursorBefore, events, calls: () => calls };
    }

    it("skips a message after 5 failed attempts, moves the cursor and reports it", async () => {
      const { f, flaky, cursorBefore, events, calls } = await poisoned();
      for (let attempt = 1; attempt <= 4; attempt++) {
        const outcome = await sync.syncMailboxInbox(inbox(f.provider, flaky), f.mailbox);
        expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining(`attempt ${attempt} of 5`) });
        expect((await mailboxRow(f.mailbox)).gmail_history_cursor).toBe(cursorBefore);
        expect(await events()).toMatchObject([{ status: "pending", attempts: attempt }]);
      }
      const last = await sync.syncMailboxInbox(inbox(f.provider, flaky), f.mailbox);
      expect(last).toMatchObject({ kind: "synced", counts: { dead_lettered: 1, reply: 1 } });
      const row = await mailboxRow(f.mailbox);
      expect(row.gmail_history_cursor).not.toBe(cursorBefore);
      expect(row.last_error).toContain("1 inbound message failed 5 times");
      const [event] = await events();
      expect(event).toMatchObject({ status: "failed", attempts: 5, provider: "gmail", event_type: "inbound_email", account_ref: f.address });
      expect(event.log).toHaveLength(5);
      expect(event.payload).toMatchObject({ subject: "poison" });
      expect((await enrollment(f.enrollmentIds[1])).status).toBe("replied");

      // A replayed batch does not try the dead message again.
      await sql`update mailboxes set gmail_history_cursor = ${cursorBefore} where id = ${f.mailbox}`;
      const replay = await sync.syncMailboxInbox(inbox(f.provider, flaky), f.mailbox);
      expect(replay).toMatchObject({ kind: "synced" });
      expect(calls()).toBe(5);
      expect((await events())[0].attempts).toBe(5);
    });

    it("a message that fails and then applies leaves no pending failure behind", async () => {
      const { f, flaky, events } = await poisoned();
      await sync.syncMailboxInbox(inbox(f.provider, flaky), f.mailbox);
      expect(await events()).toMatchObject([{ status: "pending", attempts: 1 }]);
      const healed = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
      expect(healed).toMatchObject({ kind: "synced", counts: { reply: 2 } });
      expect(await events()).toMatchObject([{ status: "done" }]);
      expect((await mailboxRow(f.mailbox)).last_error).toBeNull();
    });

    it("the job detail carries the dead-letter count", async () => {
      const { f, flaky } = await poisoned();
      const [job] = jobs.createInboxJobs({ ...inbox(f.provider, flaky), minIntervalSeconds: 0 });
      const run = () => job.run({ deadline: Date.now() + 30_000, now: () => current });
      for (let i = 0; i < 4; i++) expect((await run()).detail).toMatchObject({ mailboxes_failed: 1 });
      expect((await run()).detail).toMatchObject({ dead_lettered: 1, reply: 1 });
    });
  });

  it("a provider outage records the error and leaves the cursor alone", async () => {
    const f = await sentFixture();
    const cursorBefore = (await mailboxRow(f.mailbox)).gmail_history_cursor;
    f.provider.inboundFails = true;
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome.kind).toBe("failed");
    const row = await mailboxRow(f.mailbox);
    expect(row).toMatchObject({ status: "connected", gmail_history_cursor: cursorBefore });
    expect(row.last_error).toContain("unavailable");
  });

  it("an expired cursor is replaced, the mailbox stays connected, and the gap is noted", async () => {
    const f = await sentFixture();
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: (await sendRow(f.enrollmentIds[0])).id });
    f.provider.cursorExpired = true;
    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toEqual({ kind: "synced", counts: {}, reset: true });
    const row = await mailboxRow(f.mailbox);
    expect(row.status).toBe("connected");
    expect(row.gmail_history_cursor).toBe("1");
    expect(row.last_error).toContain("cursor expired");

    f.provider.cursorExpired = false;
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect((await mailboxRow(f.mailbox)).last_error).toBeNull();
  });

  it("the job syncs due mailboxes, isolates a failing one, and skips mailboxes synced recently", async () => {
    const good = await sentFixture();
    const bad = await sentFixture();
    const badProvider = bad.provider;
    badProvider.inboundFails = true;
    // One provider serves both mailboxes in production, so route by address here.
    const router = {
      ...good.provider,
      fetchInbound: (m: { emailAddress: string }, c: string | null) =>
        (m.emailAddress === bad.address ? badProvider : good.provider).fetchInbound(m, c),
    } as unknown as FakeMailboxProvider;
    good.provider.deliverInbound(good.address, { from: { email: good.emails[0], name: null }, sendId: (await sendRow(good.enrollmentIds[0])).id });

    const [job] = jobs.createInboxJobs({ ...inbox(router), minIntervalSeconds: 0 });
    const result = await job.run({ deadline: Date.now() + 30_000, now: () => current });
    expect(result.more).toBe(false);
    expect(result.detail).toMatchObject({ reply: 1, mailboxes_failed: 1 });
    expect((await enrollment(good.enrollmentIds[0])).status).toBe("replied");
    expect((await mailboxRow(bad.mailbox)).last_error).toContain("unavailable");

    const [throttled] = jobs.createInboxJobs({ ...inbox(router), minIntervalSeconds: 3600 });
    const again = await throttled.run({ deadline: Date.now() + 30_000, now: () => current });
    expect(again.detail?.reply ?? 0).toBe(0);
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

  it("still ingests a reply and stops the sequence while PAUSE_OUTBOUND is set", async () => {
    const f = await sentFixture();
    const row = await sendRow(f.enrollmentIds[0]);
    f.provider.deliverInbound(f.address, { from: { email: f.emails[0], name: null }, sendId: row.id });
    const outcome = await withPause("true", () => sync.syncMailboxInbox(inbox(f.provider), f.mailbox));
    expect(outcome).toMatchObject({ kind: "synced", counts: { reply: 1 } });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", next_send_at: null, stop_reason: "replied" });
    expect(await inboxMessages(f.org)).not.toHaveLength(0);
  });
});
