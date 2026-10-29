import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { LinkedInEngineDeps, LinkedInInboundDeps, LinkedInInboundStore } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";
import { MAX_INVITE_ATTEMPTS } from "../../domain/linkedin";


const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}, let us connect", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks {{firstName}} from {{company}}", waitDays: 1 },
  { stepNumber: 3, kind: "message", body: "Following up", waitDays: 3 },
];

describeDb("linkedin engine", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let engine: typeof import("../../application/send-next-linkedin");
  let inbound: typeof import("../../application/linkedin-inbound");
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let inboundStore: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let parse: typeof import("../unipile-webhook").parseUnipilePayload;
  const cleanup: string[] = [];

  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const clock = { now: () => current };
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  const deps = (gateway: FakeLinkedInGateway): LinkedInEngineDeps => ({ store, gateways: gateway, clock, random: () => 0 });
  const inboundDeps = (override?: Partial<LinkedInInboundStore>): LinkedInInboundDeps => ({
    store: override ? { ...inboundStore, ...override } : inboundStore,
    clock,
    parse,
  });

  async function fixture(options: { people?: number; dailyLimit?: number; steps?: unknown[]; hours?: unknown; premium?: boolean } = {}) {
    current = start;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('L', ${"li-" + tag}) returning id`;
    cleanup.push(org);
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, is_premium, working_hours)
      values (${org}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected', ${options.dailyLimit ?? 20}, ${options.premium ?? false},
              ${sql.json((options.hours ?? { timeZone: "UTC", days: ALL_DAY }) as never)})
      returning id`;
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${org}, 'linkedin', 'c', 'active', ${sql.json((options.steps ?? STEPS) as never)}) returning id`;
    const [{ id: company }] = await sql`insert into companies (organization_id, domain, name) values (${org}, ${`acme-${tag}.com`}, 'Acme') returning id`;
    const enrollmentIds: string[] = [];
    const slugs: string[] = [];
    for (let i = 0; i < (options.people ?? 1); i++) {
      const slug = `lead${i}-${tag}`;
      slugs.push(slug);
      const created = new Date(start.getTime() + i * 1000);
      const [{ id: person }] = await sql`
        insert into people (organization_id, linkedin_slug, first_name, company_id, created_at)
        values (${org}, ${slug}, ${"Lead" + i}, ${company}, ${created}) returning id`;
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at)
        values (${org}, ${campaign}, ${person}, 'linkedin', ${created}) returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url) values (${enrollment}, ${org}, ${"https://www.linkedin.com/in/" + slug})`;
      enrollmentIds.push(enrollment);
    }
    return { org, account, providerAccount: "acct-" + tag, tag, campaign, enrollmentIds, slugs };
  }

  const enrollment = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const details = async (id: string) => (await sql`select * from linkedin_enrollment_details where enrollment_id = ${id}`)[0];
  const sendRows = async (id: string) => await sql`select * from sends where enrollment_id = ${id} order by step_number, claimed_at`;
  const accountRow = async (id: string) => (await sql`select * from linkedin_accounts where id = ${id}`)[0];

  /** Runs one action for the account: resolve, invite, or message, whichever is due. */
  const act = (gateway: FakeLinkedInGateway, f: { account: string }) => engine.runNextLinkedInAction(deps(gateway), f.account);

  /** Resolves the profile, waits out the gap, and sends the invitation. */
  async function invite(gateway: FakeLinkedInGateway, f: { account: string }) {
    expect((await act(gateway, f)).kind).toBe("resolved");
    advance(2);
    return act(gateway, f);
  }

  const acceptedPayload = (f: { providerAccount: string }, member: string) => ({
    event: "new_relation",
    account_id: f.providerAccount,
    account_type: "LINKEDIN",
    user_full_name: "Lead",
    user_provider_id: member,
    user_profile_url: "https://www.linkedin.com/in/x",
  });
  const replyPayload = (f: { providerAccount: string; tag: string }, member: string, messageId: string, text = "Sounds good") => ({
    event: "message_received",
    account_id: f.providerAccount,
    account_type: "LINKEDIN",
    account_info: { type: "LINKEDIN", user_id: "ACo-owner-" + f.tag },
    chat_id: "chat-x",
    message_id: messageId,
    message: text,
    sender: { attendee_provider_id: member },
    attendees: [{ attendee_provider_id: member }, { attendee_provider_id: "ACo-owner-" + f.tag }],
  });

  beforeAll(async () => {
    engine = await import("../../application/send-next-linkedin");
    inbound = await import("../../application/linkedin-inbound");
    ({ drizzleLinkedInStore: store } = await import("../drizzle-linkedin-store"));
    inboundStore = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ parseUnipilePayload: parse } = await import("../unipile-webhook"));
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("resolves the profile, then sends the invitation with a rendered note and waits for acceptance", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    expect((await invite(gateway, f)).kind).toBe("sent");

    expect(gateway.invitations).toHaveLength(1);
    expect(gateway.invitations[0]).toMatchObject({ member: `ACo-${f.slugs[0]}`, note: "Hi Lead0, let us connect" });
    const e = await enrollment(f.enrollmentIds[0]);
    expect(e).toMatchObject({ status: "active", current_step: 1, next_send_at: null, linkedin_account_id: f.account });
    expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent", provider_id: `ACo-${f.slugs[0]}` });
    const [row] = await sendRows(f.enrollmentIds[0]);
    expect(row).toMatchObject({ status: "sent", attempt: 1, channel: "linkedin", provider_message_id: gateway.invitations[0].id });
  });

  it("paces actions with the account gap", async () => {
    const f = await fixture({ people: 2 });
    const gateway = new FakeLinkedInGateway();
    expect((await invite(gateway, f)).kind).toBe("sent");
    // Invite gap is 10 minutes with random() = 0. The second person is resolved after it, not before.
    advance(9);
    expect((await act(gateway, f)).kind).toBe("idle");
    advance(1);
    expect((await act(gateway, f)).kind).toBe("resolved");
  });

  it("stops inviting at the daily limit and at the weekly cap", async () => {
    const daily = await fixture({ people: 2, dailyLimit: 1 });
    const gateway = new FakeLinkedInGateway();
    expect((await invite(gateway, daily)).kind).toBe("sent");
    advance(11);
    expect((await act(gateway, daily)).kind).toBe("resolved");
    for (let i = 0; i < 3; i++) {
      advance(11);
      expect((await act(gateway, daily)).kind).toBe("idle");
    }
    expect(gateway.invitations).toHaveLength(1);
    // The next local day opens the quota again.
    current = new Date("2026-10-15T10:00:00Z");
    expect((await act(gateway, daily)).kind).toBe("sent");

    const weekly = await fixture({ people: 2, dailyLimit: 50 });
    await sql`insert into channel_settings (organization_id, channel, values) values (${weekly.org}, 'linkedin', ${sql.json({ invitesPerWeek: 1 })})`;
    const g2 = new FakeLinkedInGateway();
    expect((await invite(g2, weekly)).kind).toBe("sent");
    // Two days later the day quota is fresh but the week is not.
    current = new Date("2026-10-16T10:00:00Z");
    expect((await act(g2, weekly)).kind).toBe("resolved");
    advance(11);
    expect((await act(g2, weekly)).kind).toBe("idle");
    expect(g2.invitations).toHaveLength(1);
    current = new Date("2026-10-22T10:00:00Z");
    expect((await act(g2, weekly)).kind).toBe("sent");
  });

  it("counts invitations still sending or with an unknown outcome toward the daily and weekly limits", async () => {
    /** Two invitations in flight or unknown at `claimedAt`, and a third lead ready to invite. */
    async function heldQuota(options: { dailyLimit: number; claimedAt: Date }) {
      const f = await fixture({ people: 3, dailyLimit: options.dailyLimit });
      for (const [i, status] of (["unknown", "sending"] as const).entries()) {
        await sql`update campaign_enrollments set status = 'active', current_step = 1, linkedin_account_id = ${f.account} where id = ${f.enrollmentIds[i]}`;
        await sql`
          insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, attempt, claimed_at)
          values (${f.org}, ${f.enrollmentIds[i]}, 1, 'linkedin', ${status}, ${f.account}, 1, ${options.claimedAt})`;
      }
      await sql`update campaign_enrollments set linkedin_account_id = ${f.account} where id = ${f.enrollmentIds[2]}`;
      await sql`update linkedin_enrollment_details set provider_id = ${"ACo-" + f.slugs[2]} where enrollment_id = ${f.enrollmentIds[2]}`;
      return f;
    }
    /** Fails the organization's open sends, so a later reconcile in this file does not count them. */
    const settle = (org: string) => sql`update sends set status = 'failed', attempt = 3 where organization_id = ${org} and status in ('sending', 'unknown')`;

    const daily = await heldQuota({ dailyLimit: 2, claimedAt: start });
    const gateway = new FakeLinkedInGateway();
    advance(30);
    expect((await act(gateway, daily)).kind).toBe("idle");
    expect(gateway.invitations).toHaveLength(0);
    await settle(daily.org);

    const weekly = await heldQuota({ dailyLimit: 50, claimedAt: new Date(start.getTime() - 2 * 86_400_000) });
    await sql`insert into channel_settings (organization_id, channel, values) values (${weekly.org}, 'linkedin', ${sql.json({ invitesPerWeek: 2 })})`;
    const g2 = new FakeLinkedInGateway();
    expect((await act(g2, weekly)).kind).toBe("idle");
    expect(g2.invitations).toHaveLength(0);
    await settle(weekly.org);
  });

  it("does nothing outside the account's working hours", async () => {
    const hours = { timeZone: "UTC", days: { "3": [{ start: "12:00", end: "18:00" }] } };
    const f = await fixture({ hours });
    const gateway = new FakeLinkedInGateway();
    expect((await act(gateway, f)).kind).toBe("idle");
    advance(120);
    expect((await act(gateway, f)).kind).toBe("resolved");
  });

  it("sends the follow-ups after acceptance, on the step schedule, and finishes the sequence", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;

    const accepted = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });
    expect(accepted.status).toBe("done");
    const afterAccept = await enrollment(f.enrollmentIds[0]);
    expect(afterAccept.status).toBe("active");
    expect(new Date(afterAccept.next_send_at).toISOString()).toBe("2026-10-15T10:02:00.000Z");
    expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });

    advance(60);
    expect((await act(gateway, f)).kind).toBe("idle");
    current = new Date("2026-10-15T10:03:00Z");
    expect((await act(gateway, f)).kind).toBe("sent");
    expect(gateway.messages.map((m) => m.text)).toEqual(["Thanks Lead0 from Acme"]);
    expect((await enrollment(f.enrollmentIds[0])).current_step).toBe(2);

    // A connection row now holds the chat, so the next message goes to the same chat.
    current = new Date("2026-10-18T10:10:00Z");
    expect((await act(gateway, f)).kind).toBe("sent");
    expect(gateway.messages.map((m) => m.text)).toEqual(["Thanks Lead0 from Acme", "Following up"]);
    expect(new Set(gateway.messages.map((m) => m.chat)).size).toBe(1);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "completed", current_step: 3, next_send_at: null });
  });

  it("holds messages once the account's daily message cap is reached and sends the rest the next UTC day", async () => {
    const f = await fixture({ people: 2 });
    const gateway = new FakeLinkedInGateway();
    await sql`update linkedin_accounts set daily_message_limit = 1 where id = ${f.account}`;
    await invite(gateway, f);
    advance(20);
    await invite(gateway, f);
    for (const slug of f.slugs) {
      const accepted = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, `ACo-${slug}`) });
      expect(accepted.status).toBe("done");
    }
    current = new Date("2026-10-15T11:00:00Z");
    expect((await act(gateway, f)).kind).toBe("sent");
    advance(10);
    // The second message is due and the gap passed, but the cap of one is spent for this UTC day.
    expect((await act(gateway, f)).kind).toBe("idle");
    expect(gateway.messages).toHaveLength(1);
    const [row] = await sql`select count(*)::int as n from sends where linkedin_account_id = ${f.account} and step_number = 2`;
    expect(row.n).toBe(1);
    current = new Date("2026-10-16T00:05:00Z");
    expect((await act(gateway, f)).kind).toBe("sent");
    expect(gateway.messages).toHaveLength(2);
  });

  it("blocks a message to a lead marked do not contact after the claim and before the provider", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const accepted = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, `ACo-${f.slugs[0]}`) });
    expect(accepted.status).toBe("done");
    current = new Date("2026-10-15T10:03:00Z");
    // The flag lands between the claim and the provider call.
    const racing: typeof store = {
      ...store,
      async claimNext(options) {
        const claim = await store.claimNext(options);
        if (claim) {
          await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at)
            select person_id, organization_id, true, 'human', now() from campaign_enrollments where id = ${f.enrollmentIds[0]}`;
        }
        return claim;
      },
    };
    expect(await engine.runNextLinkedInAction({ ...deps(gateway), store: racing }, f.account)).toEqual({ kind: "blocked", reason: "do_not_contact" });
    expect(gateway.messages).toHaveLength(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "suppressed", stop_reason: "do_not_contact", next_send_at: null });
    const rows = await sendRows(f.enrollmentIds[0]);
    expect(rows.find((r) => r.step_number === 2)).toMatchObject({ status: "failed", attempt: 3, error: "do_not_contact" });
  });

  it("stops the sequence when the lead replies, and a redelivered reply changes nothing", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });

    const reply = replyPayload(f, member, "m-1");
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: reply })).status).toBe("done");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", next_send_at: null, stop_reason: "replied" });
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: reply })).status).toBe("duplicate");

    current = new Date("2026-10-20T10:00:00Z");
    expect((await act(gateway, f)).kind).toBe("idle");
    expect(gateway.messages).toHaveLength(0);
    const [conn] = await sql`select chat_id from linkedin_connections where linkedin_account_id = ${f.account}`;
    expect(conn.chat_id).toBe("chat-x");
  });

  it("treats the echo of our own note as an acceptance, and ignores other echoes", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    const echo = { ...replyPayload(f, member, "e-1", "Hi Lead0, let us connect"), sender: { attendee_provider_id: "ACo-owner-" + f.tag } };
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: echo })).status).toBe("done");
    expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
    const second = { ...echo, message_id: "e-2" };
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: second })).status).toBe("skipped");
    expect((await enrollment(f.enrollmentIds[0])).status).toBe("active");
  });

  const inboxRows = (org: string) =>
    sql`select m.*, c.provider_thread_id, c.channel as conversation_channel, r.person_id from messages m join conversations c on c.id = m.conversation_id join records r on r.id = c.record_id where m.organization_id = ${org} order by m.created_at`;

  it("stores a reply in the master inbox under the enrolled lead, once, and shows it in the inbox list", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });

    const reply = {
      ...replyPayload(f, member, "m-inbox", "Let us talk"),
      sender: { attendee_provider_id: member, attendee_name: "Someone Else", attendee_profile_url: "https://www.linkedin.com/in/" + f.slugs[0] },
      timestamp: "2026-10-14T11:30:00.000Z",
    };
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: reply })).status).toBe("done");
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: reply })).status).toBe("duplicate");

    const rows = await inboxRows(f.org);
    expect(rows).toHaveLength(1);
    const [{ person_id: lead }] = await sql`select person_id from campaign_enrollments where id = ${f.enrollmentIds[0]}`;
    expect(rows[0]).toMatchObject({
      channel: "linkedin",
      account_ref: f.account,
      direction: "inbound",
      idempotency_key: `linkedin:${f.account}:m-inbox`,
      provider_thread_id: "chat-x",
      body_text: "Let us talk",
      person_id: lead,
    });
    expect(new Date(rows[0].sent_at).toISOString()).toBe("2026-10-14T11:30:00.000Z");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied" });

    const conversations = await import("@/contexts/conversations/infrastructure/composition");
    const inbox = await import("@/contexts/conversations/application/inbox");
    const actor = { userId: "00000000-0000-0000-0000-000000000000", organizationId: f.org, role: "owner" as const };
    const list = await inbox.listInbox(conversations.inboxDeps(), actor, {});
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ channel: "linkedin", snippet: "Let us talk", unreadCount: 1 });
    // The thread also carries the invitation note we sent.
    const thread = await inbox.getThread(conversations.inboxDeps(), actor, list.rows[0].conversationId);
    expect(thread.messages.map((m) => [m.direction, m.bodyText])).toEqual([
      ["outbound", "Hi Lead0, let us connect"],
      ["inbound", "Let us talk"],
    ]);
  });

  it("stores a reply that arrives after the sequence ended, under the same lead", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: replyPayload(f, member, "first") });
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: replyPayload(f, member, "second", "One more thing") });
    const rows = await inboxRows(f.org);
    expect(rows.map((r) => r.body_text)).toEqual(["Sounds good", "One more thing"]);
    expect(new Set(rows.map((r) => r.conversation_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.person_id)).size).toBe(1);
  });

  it("stores a real message from someone in no sequence as a new inbound person", async () => {
    const f = await fixture();
    const stranger = {
      ...replyPayload(f, "ACo-stranger", "s-1", "Saw your profile"),
      sender: { attendee_provider_id: "ACo-stranger", attendee_name: "Sam Stranger", attendee_profile_url: "https://www.linkedin.com/in/sam-stranger" },
    };
    const result = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: stranger });
    expect(result.status).toBe("done");
    const rows = await inboxRows(f.org);
    expect(rows).toHaveLength(1);
    const [person] = await sql`select * from people where id = ${rows[0].person_id}`;
    expect(person).toMatchObject({ linkedin_slug: "sam-stranger", full_name: "Sam Stranger", source: "inbound" });
    expect(rows[0].from_address).toBe("Sam Stranger");
  });

  it("does not store our own messages, and stores nothing for another organization's account", async () => {
    const f = await fixture();
    const other = await fixture();
    const own = { ...replyPayload(f, "ACo-someone", "own-1", "I wrote this"), sender: { attendee_provider_id: "ACo-owner-" + f.tag } };
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: own })).status).toBe("skipped");
    expect(await inboxRows(f.org)).toHaveLength(0);

    // The delivery claims another organization's account: ignored, nothing stored for either.
    const foreign = replyPayload(f, "ACo-sneaky", "x-1", "Hello");
    expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: other.org, payload: foreign })).status).toBe("skipped");
    expect(await inboxRows(f.org)).toHaveLength(0);
    expect(await inboxRows(other.org)).toHaveLength(0);
  });

  it("replays a failed inbox write without losing the reply or stopping the sequence twice", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });

    const reply = replyPayload(f, member, "retry-1", "Please call");
    // The first attempt does its work, then fails before the ledger row is closed. The replay job runs it again.
    let calls = 0;
    const flaky = inboundDeps({
      apply: async (org, event, now) => {
        calls += 1;
        if (calls === 1) {
          await inboundStore.apply(org, event, now);
          throw new Error("inbox unavailable");
        }
        return inboundStore.apply(org, event, now);
      },
    });
    const first = await inbound.receiveLinkedInWebhook(flaky, { organizationId: f.org, payload: reply });
    expect(first.status).toBe("failed");
    current = new Date(current.getTime() + 60_000);
    const report = await inbound.replayLinkedInEvents(flaky);
    expect(report).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    const rows = await inboxRows(f.org);
    expect(rows.map((r) => r.body_text)).toEqual(["Please call"]);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied" });
  });

  /** Everything a late writer could touch: the send, the enrollment, the LinkedIn details, the remembered chats. */
  async function snapshot(f: { org: string }, enrollmentId: string) {
    const [send] = await sendRows(enrollmentId);
    const chats = await sql`select provider_id, chat_id from linkedin_connections where organization_id = ${f.org} order by provider_id`;
    return JSON.parse(JSON.stringify({ send, enrollment: await enrollment(enrollmentId), details: await details(enrollmentId), chats }));
  }

  /** Runs a worker whose settle call is followed by the calls of a slow worker, and records what those calls changed. */
  async function runWithLateWriters(f: Awaited<ReturnType<typeof fixture>>, gateway: FakeLinkedInGateway) {
    const changes: unknown[] = [];
    const late = async (claim: Parameters<typeof store.markFailed>[0]) => {
      const before = await snapshot(f, claim.enrollmentId);
      await store.markFailed(claim, "late failure", current, 5, 3, false);
      await store.markFailed(claim, "late fatal failure", current, 0, 3, true);
      await store.markUnknown(claim, "late unknown");
      await store.markSent(claim, { providerMessageId: "late-pm", chatId: "late-chat" }, current);
      changes.push({ before, after: await snapshot(f, claim.enrollmentId) });
    };
    const guarded = {
      ...store,
      markSent: async (...a: Parameters<typeof store.markSent>) => { await store.markSent(...a); await late(a[0]); },
      markFailed: async (...a: Parameters<typeof store.markFailed>) => { await store.markFailed(...a); await late(a[0]); },
      markUnknown: async (...a: Parameters<typeof store.markUnknown>) => { await store.markUnknown(...a); await late(a[0]); },
    } as typeof store;
    expect((await engine.runNextLinkedInAction({ ...deps(gateway), store: guarded }, f.account)).kind).toBe("resolved");
    advance(2);
    const result = await engine.runNextLinkedInAction({ ...deps(gateway), store: guarded }, f.account);
    return { result, changes: changes as Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> };
  }

  it("a late markFailed, markUnknown or markSent leaves a sent LinkedIn send sent, with no retry and one advance", async () => {
    const f = await fixture();
    const { result, changes } = await runWithLateWriters(f, new FakeLinkedInGateway());
    expect(result.kind).toBe("sent");
    expect(changes).toHaveLength(1);
    expect(changes[0].after).toEqual(changes[0].before);
    const [send] = await sendRows(f.enrollmentIds[0]);
    expect(send).toMatchObject({ status: "sent", error: null, attempt: 1 });
    expect(send.provider_message_id).not.toBe("late-pm");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "active", current_step: 1, next_send_at: null });
    expect(await sql`select 1 from linkedin_connections where organization_id = ${f.org}`).toHaveLength(0);
  });

  it("a late markSent leaves a failed LinkedIn send failed, without advancing or changing the retry schedule", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => ({ refuse: "rejected" });
    const { result, changes } = await runWithLateWriters(f, gateway);
    expect(result.kind).toBe("failed");
    expect(changes).toHaveLength(1);
    expect(changes[0].after).toEqual(changes[0].before);
    const [send] = await sendRows(f.enrollmentIds[0]);
    expect(send).toMatchObject({ status: "failed", attempt: 1 });
    expect(send.provider_message_id).toBeNull();
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending", current_step: 0 });
    expect(await details(f.enrollmentIds[0])).not.toMatchObject({ connection_state: "request_sent" });
    expect(await sql`select 1 from linkedin_connections where organization_id = ${f.org}`).toHaveLength(0);
  });

  it("a late markFailed and markSent leave an unknown LinkedIn send unknown", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => "timeout-after-accept";
    const { result, changes } = await runWithLateWriters(f, gateway);
    expect(result.kind).toBe("unknown");
    expect(changes[0].after).toEqual(changes[0].before);
    expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "unknown", error: expect.not.stringContaining("late") });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending", current_step: 0 });
    // Reconcile looks at every unknown send in the database, so settle this one for the tests after it.
    await sql`update sends set status = 'failed', attempt = 3 where enrollment_id = ${f.enrollmentIds[0]}`;
  });

  it("never retries an invitation with an unknown outcome, and reconciles it from LinkedIn", async () => {
    const f = await fixture({ people: 2 });
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = (member) => (member.endsWith(f.slugs[0]) ? "timeout-after-accept" : "ok");
    expect((await invite(gateway, f)).kind).toBe("unknown");
    expect((await enrollment(f.enrollmentIds[0])).current_step).toBe(0);
    expect((await sendRows(f.enrollmentIds[0]))[0].status).toBe("unknown");

    // Hours later nothing re-sends it, even though the enrollment looks due.
    advance(12);
    await act(gateway, f);
    expect(gateway.invitations.filter((i) => i.member.endsWith(f.slugs[0]))).toHaveLength(1);

    const report = await engine.reconcileLinkedInSends(deps(gateway));
    expect(report.foundSent).toBe(1);
    expect((await sendRows(f.enrollmentIds[0]))[0].status).toBe("sent");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "active", current_step: 1 });
    expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent" });
  });

  it("makes a lost invitation retryable only after the grace period, and keeps waiting while LinkedIn cannot answer", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => "timeout-lost";
    expect((await invite(gateway, f)).kind).toBe("unknown");

    advance(11);
    gateway.readOutage = true;
    expect((await engine.reconcileLinkedInSends(deps(gateway))).stillWaiting).toBe(1);
    gateway.readOutage = false;
    expect((await engine.reconcileLinkedInSends(deps(gateway))).stillWaiting).toBe(1);
    expect((await sendRows(f.enrollmentIds[0]))[0].status).toBe("unknown");

    advance(20);
    expect((await engine.reconcileLinkedInSends(deps(gateway))).retryable).toBe(1);
    expect((await sendRows(f.enrollmentIds[0]))[0].status).toBe("failed");

    gateway.inviteBehavior = () => "ok";
    advance(20);
    expect((await act(gateway, f)).kind).toBe("sent");
    expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "sent", attempt: 2 });
  });

  it("reconciles an unknown message by looking for it in the chat", async () => {
    const f = await fixture({ people: 2 });
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });

    gateway.messageBehavior = () => "timeout-after-accept";
    current = new Date("2026-10-16T10:00:00Z");
    expect((await act(gateway, f)).kind).toBe("unknown");
    advance(12);
    expect((await engine.reconcileLinkedInSends(deps(gateway))).foundSent).toBe(1);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ current_step: 2, status: "active" });
    expect(gateway.messages).toHaveLength(1);
  });

  it("pauses the account for a day when LinkedIn reports a limit, without spending the attempt", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => ({ refuse: "rate_limited" });
    expect((await invite(gateway, f)).kind).toBe("paused");
    expect((await accountRow(f.account)).limit_reached_until).not.toBeNull();
    expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt: 0 });

    gateway.inviteBehavior = () => "ok";
    advance(60);
    expect((await act(gateway, f)).kind).toBe("idle");
    advance(24 * 60);
    expect((await act(gateway, f)).kind).toBe("sent");
  });

  it("marks the account disconnected on an auth refusal", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => ({ refuse: "auth" });
    expect((await invite(gateway, f)).kind).toBe("paused");
    expect((await accountRow(f.account)).status).toBe("disconnected");
    expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", attempt: 0 });
  });

  it("fails an invitation for good on insufficient_privileges and keeps the account connected", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => ({ refuse: "insufficient_privileges" });
    expect(await invite(gateway, f)).toEqual({ kind: "failed", retry: false });
    expect((await accountRow(f.account)).status).toBe("connected");
    expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ status: "failed", error: "Fake refusal: insufficient_privileges" });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed" });
    advance(24 * 60);
    expect((await act(gateway, f)).kind).toBe("idle");
    expect(gateway.invitations).toHaveLength(0);
  });

  // Migration 0004 took the cap out of the sends trigger, so these two tests are what holds it.
  describe("the attempt cap", () => {
    it("is three attempts", () => {
      expect(MAX_INVITE_ATTEMPTS).toBe(3);
    });

    it("asks LinkedIn at most MAX_INVITE_ATTEMPTS times for an invitation, then ends the enrollment failed", async () => {
      const f = await fixture();
      const gateway = new FakeLinkedInGateway();
      let calls = 0;
      gateway.inviteBehavior = () => {
        calls += 1;
        return { refuse: "rejected" };
      };
      expect((await act(gateway, f)).kind).toBe("resolved");
      for (let attempt = 1; attempt <= MAX_INVITE_ATTEMPTS; attempt++) {
        advance(24 * 60);
        expect(await act(gateway, f)).toEqual({ kind: "failed", retry: attempt < MAX_INVITE_ATTEMPTS });
        expect((await sendRows(f.enrollmentIds[0]))[0]).toMatchObject({ step_number: 1, status: "failed", attempt, error: "Fake refusal: rejected" });
      }
      expect(calls).toBe(MAX_INVITE_ATTEMPTS);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed", stop_reason: "send_failed: Fake refusal: rejected", next_send_at: null, current_step: 0 });

      // LinkedIn would accept now, and is never asked again.
      gateway.inviteBehavior = () => {
        calls += 1;
        return "ok";
      };
      for (let i = 0; i < 3; i++) {
        advance(24 * 60);
        expect((await act(gateway, f)).kind).toBe("idle");
      }
      expect(calls).toBe(MAX_INVITE_ATTEMPTS);
      expect(await sendRows(f.enrollmentIds[0])).toHaveLength(1);
      expect(gateway.invitations).toHaveLength(0);
    });

    it("asks LinkedIn at most MAX_INVITE_ATTEMPTS times for a follow-up message, then ends the enrollment failed", async () => {
      const f = await fixture();
      const gateway = new FakeLinkedInGateway();
      await invite(gateway, f);
      const accepted = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, `ACo-${f.slugs[0]}`) });
      expect(accepted.status).toBe("done");
      let calls = 0;
      gateway.messageBehavior = () => {
        calls += 1;
        return { refuse: "rejected" };
      };
      for (let attempt = 1; attempt <= MAX_INVITE_ATTEMPTS; attempt++) {
        advance(24 * 60);
        expect(await act(gateway, f)).toEqual({ kind: "failed", retry: attempt < MAX_INVITE_ATTEMPTS });
        expect((await sendRows(f.enrollmentIds[0])).find((r) => r.step_number === 2)).toMatchObject({ status: "failed", attempt, error: "Fake refusal: rejected" });
      }
      expect(calls).toBe(MAX_INVITE_ATTEMPTS);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed", stop_reason: "send_failed: Fake refusal: rejected", next_send_at: null, current_step: 1 });

      gateway.messageBehavior = () => {
        calls += 1;
        return "ok";
      };
      for (let i = 0; i < 3; i++) {
        advance(24 * 60);
        expect((await act(gateway, f)).kind).toBe("idle");
      }
      expect(calls).toBe(MAX_INVITE_ATTEMPTS);
      expect(gateway.messages).toHaveLength(0);
    });
  });

  it("skips the invitation when LinkedIn says we are already connected", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.inviteBehavior = () => ({ refuse: "already_connected" });
    await invite(gateway, f);
    expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "active", current_step: 1 });
    expect(gateway.invitations).toHaveLength(0);
  });

  it("fails the lead when the rendered note exceeds 300 characters", async () => {
    const f = await fixture({ steps: [{ stepNumber: 1, kind: "invitation", body: "{{firstName}} " + "x".repeat(299), waitDays: 0 }] });
    const gateway = new FakeLinkedInGateway();
    expect((await invite(gateway, f)).kind).toBe("failed");
    expect(gateway.invitations).toHaveLength(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed" });
  });

  it("fails a lead whose profile cannot be found, after recording why", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    expect((await act(gateway, f)).kind).toBe("resolve_failed");
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "failed" });
    expect((await details(f.enrollmentIds[0])).resolve_last_error).toContain("Profile not found");
  });

  it("retries a failed lookup on the 60 then 120 minute ladder", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    gateway.readOutage = true;
    expect((await act(gateway, f)).kind).toBe("resolve_failed");
    expect((await details(f.enrollmentIds[0])).resolve_retry_count).toBe(1);
    advance(59);
    expect((await act(gateway, f)).kind).toBe("idle");
    advance(1);
    expect((await act(gateway, f)).kind).toBe("resolve_failed");
    advance(119);
    expect((await act(gateway, f)).kind).toBe("idle");
    gateway.readOutage = false;
    advance(1);
    expect((await act(gateway, f)).kind).toBe("resolved");
  });

  it("does not invite the same person twice from one account", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const [{ person_id: person }] = await sql`select person_id from campaign_enrollments where id = ${f.enrollmentIds[0]}`;
    const [{ id: second }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'c2', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: e2 }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, linkedin_account_id) values (${f.org}, ${second}, ${person}, 'linkedin', ${f.account}) returning id`;
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id) values (${e2}, ${f.org}, ${"ACo-" + f.slugs[0]})`;
    advance(11);
    await act(gateway, f);
    expect(gateway.invitations).toHaveLength(1);
    expect(await enrollment(e2)).toMatchObject({ status: "suppressed", stop_reason: "already_contacted_by_account" });
  });

  it("pauses nothing it should not: a paused campaign gives the attempt back", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    expect((await act(gateway, f)).kind).toBe("resolved");
    await sql`update campaigns set status = 'paused' where id = ${f.campaign}`;
    advance(2);
    expect((await act(gateway, f)).kind).toBe("idle");
    expect(gateway.invitations).toHaveLength(0);
  });

  it("ends a sequence whose invitation nobody accepted within 30 days", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    current = new Date(start.getTime() + 31 * 86_400_000);
    expect((await engine.reconcileLinkedInSends(deps(gateway))).expired).toBeGreaterThanOrEqual(1);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "completed", stop_reason: "invite_not_accepted" });
  });

  describe("webhook ledger", () => {
    it("records a failed delivery and replays it later", async () => {
      const f = await fixture();
      const gateway = new FakeLinkedInGateway();
      await invite(gateway, f);
      const member = `ACo-${f.slugs[0]}`;
      let calls = 0;
      const flaky = inboundDeps({
        async apply(org, event, now) {
          if (++calls === 1) throw new Error("database blip");
          return inboundStore.apply(org, event, now);
        },
      });
      const payload = acceptedPayload(f, member);
      const first = await inbound.receiveLinkedInWebhook(flaky, { organizationId: f.org, payload });
      expect(first).toEqual({ status: "failed", error: "database blip" });
      const [row] = await sql`select * from inbound_events where organization_id = ${f.org}`;
      expect(row).toMatchObject({ status: "failed", provider: "unipile", attempts: 1 });
      expect(row.log[0].message).toBe("database blip");
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent" });

      // A provider retry of the same delivery does no work. Replay does.
      expect((await inbound.receiveLinkedInWebhook(flaky, { organizationId: f.org, payload })).status).toBe("duplicate");
      expect((await inbound.replayLinkedInEvents(flaky)).claimed).toBe(0);
      advance(1);
      const replay = await inbound.replayLinkedInEvents(flaky);
      expect(replay).toMatchObject({ claimed: 1, done: 1 });
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
      const [after] = await sql`select * from inbound_events where organization_id = ${f.org}`;
      expect(after).toMatchObject({ status: "done", attempts: 2 });
    });

    it("recovers a delivery whose worker died mid-way once the lease expires", async () => {
      const f = await fixture();
      const gateway = new FakeLinkedInGateway();
      await invite(gateway, f);
      const row = await inboundStore.begin({ organizationId: f.org, key: "k-" + f.tag, eventType: "new_relation", accountRef: f.providerAccount, payload: acceptedPayload(f, `ACo-${f.slugs[0]}`), now: current });
      expect(row).not.toBeNull();
      expect((await inbound.replayLinkedInEvents(inboundDeps())).claimed).toBe(0);
      advance(6);
      expect(await inbound.replayLinkedInEvents(inboundDeps())).toMatchObject({ claimed: 1, done: 1 });
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
    });

    it("ignores an event for an account of another organization, and payloads it does not handle", async () => {
      const f = await fixture();
      const other = await fixture();
      const result = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: other.org, payload: acceptedPayload(f, "ACo-someone") });
      expect(result.status).toBe("skipped");
      expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: { event: "message_read", account_id: f.providerAccount, account_type: "LINKEDIN" } })).status).toBe("ignored");
      expect((await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: { event: "new_relation", account_id: "x", account_type: "WHATSAPP", user_provider_id: "y" } })).status).toBe("ignored");
    });

    it("authenticates deliveries with the organization's secret", async () => {
      const f = await fixture();
      const { receiveUnipileWebhook: receiveUnipileDelivery } = await import("@/composition/inbox-filing");
      const { drizzleLinkedInAccountStore } = await import("../drizzle-linkedin-account-store");
      await drizzleLinkedInAccountStore.saveCredentials(f.org, { dsn: "api1.unipile.com:13111", apiKey: "key", notifySecret: "s".repeat(32) });
      const payload = acceptedPayload(f, "ACo-nobody");
      expect(await receiveUnipileDelivery({ organizationId: f.org, secret: null, payload })).toEqual({ status: 401 });
      expect(await receiveUnipileDelivery({ organizationId: f.org, secret: "wrong", payload })).toEqual({ status: 401 });
      const ok = await receiveUnipileDelivery({ organizationId: f.org, secret: "s".repeat(32), payload });
      expect(ok.status).toBe(200);
      // The stored blob is encrypted.
      const [stored] = await sql`select c.encrypted_payload from integration_credentials c join integration_accounts a on a.id = c.account_id where a.organization_id = ${f.org}`;
      expect(stored.encrypted_payload).toMatch(/^v2:/);
      expect(stored.encrypted_payload).not.toContain("key");
      // Another organization cannot use this secret.
      const other = await fixture();
      expect(await receiveUnipileDelivery({ organizationId: other.org, secret: "s".repeat(32), payload })).toEqual({ status: 401 });
    });
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

  it("claims nothing while PAUSE_OUTBOUND is set, and resumes once it is unset", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await withPause("true", async () => {
      expect((await act(gateway, f)).kind).toBe("idle");
      advance(60);
      expect((await act(gateway, f)).kind).toBe("idle");
    });
    // No profile lookup, no invitation, no send row, no claim on the enrollment.
    expect(gateway.invitations).toHaveLength(0);
    const [{ n }] = await sql`select count(*)::int as n from sends where organization_id = ${f.org}`;
    expect(n).toBe(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending" });
    expect(gateway.profileCalls).toHaveLength(0);

    expect((await withPause(undefined, () => act(gateway, f))).kind).toBe("resolved");
  });

  it("claims nothing while the organization paused sending, and resumes once it is lifted", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ sendingPaused: { at: "2026-01-01T00:00:00.000Z", byName: "Ada" } })})
      on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;
    expect((await act(gateway, f)).kind).toBe("idle");
    expect(gateway.profileCalls).toHaveLength(0);
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "pending" });

    await sql`update channel_settings set values = values || ${sql.json({ sendingPaused: null })} where organization_id = ${f.org} and channel = 'general'`;
    expect((await act(gateway, f)).kind).toBe("resolved");
  });

  it("still records a reply and stops the sequence while PAUSE_OUTBOUND is set", async () => {
    const f = await fixture();
    const gateway = new FakeLinkedInGateway();
    await invite(gateway, f);
    const member = `ACo-${f.slugs[0]}`;
    await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: acceptedPayload(f, member) });
    await withPause("true", async () => {
      const reply = await inbound.receiveLinkedInWebhook(inboundDeps(), { organizationId: f.org, payload: replyPayload(f, member, "paused-1") });
      expect(reply.status).toBe("done");
    });
    expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", stop_reason: "replied" });
  });
});
