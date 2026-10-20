import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundLinkedInInput } from "../../application/linkedin-ports";
import type { LinkedInReplyDeps } from "../../application/linkedin-reply";
import type { LinkedInReplySender } from "../../application/linkedin-reply-ports";
import type { FakeLinkedInGateway } from "@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

describeDb("LinkedIn conversation replies", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let composition: typeof import("../composition");
  let app: typeof import("../../application/linkedin-reply");
  let store: typeof import("../drizzle-linkedin-reply-store").drizzleLinkedInReplyStore;
  let makeSender: typeof import("../linkedin-reply-sender").createLinkedInReplySender;
  let Fake: typeof import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway").FakeLinkedInGateway;
  let resolveApp: typeof import("../../application/reply-management");
  let replyStore: typeof import("../drizzle-reply-store").drizzleReplyStore;
  let unread: typeof import("../drizzle-unread-store").drizzleUnreadStore;
  let inboxApp: typeof import("../../application/inbox");
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture(opts: { gap?: number } = {}) {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "LI reply");
    orgs.push(created);
    const { organizationId: org, userId: user } = created;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-" + tag}, 'Jo Owner', 'connected') returning id`;
    // Tests send more than one message in a row, so the gap between replies is off unless a test asks for it.
    await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql.json({ replyGapSeconds: opts.gap ?? 0 })})`;
    const fake: FakeLinkedInGateway = new Fake();
    const n = ++counter;
    const input: InboundLinkedInInput = {
      organizationId: org,
      accountRef: account,
      accountName: "Jo Owner",
      providerThreadId: `chat-${tag}-${n}`,
      providerMessageId: `msg-${tag}-${n}`,
      counterparty: { providerId: `ACo-lead-${n}`, name: "Ada Lovelace", profileUrl: `https://www.linkedin.com/in/ada-${tag}`, slug: `ada-${tag}` },
      personId: null,
      bodyText: "Sounds good, tell me more",
      receivedAt: new Date(),
    };
    const ingested = await composition.ingestInboundLinkedInMessage(input);
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const deps: LinkedInReplyDeps = { store, sender: makeSender(fake), now: () => new Date() };
    return { org, user, account: account as string, actor, fake, deps, tag, conversationId: ingested.conversationId, personId: ingested.personId, input };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const key = () => `key-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);
  const send = (f: Fx, text = "Happy to share more.", k = key()) => app.sendLinkedInReply(f.deps, f.actor, f.conversationId, { text, idempotencyKey: k });
  /** Makes unsettled attempts old enough for the reconcile pass. */
  const age = (f: Fx, minutes: number) => sql`update send_attempts set created_at = created_at - ${minutes + " minutes"}::interval, updated_at = updated_at - ${minutes + " minutes"}::interval where organization_id = ${f.org}`;

  beforeAll(async () => {
    composition = await import("../composition");
    app = await import("../../application/linkedin-reply");
    store = (await import("../drizzle-linkedin-reply-store")).drizzleLinkedInReplyStore;
    makeSender = (await import("../linkedin-reply-sender")).createLinkedInReplySender;
    Fake = (await import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway")).FakeLinkedInGateway;
    resolveApp = await import("../../application/reply-management");
    replyStore = (await import("../drizzle-reply-store")).drizzleReplyStore;
    unread = (await import("../drizzle-unread-store")).drizzleUnreadStore;
    inboxApp = await import("../../application/inbox");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("claims before the call, sends once, stores the message and moves the record to waiting", async () => {
    const f = await fixture();
    let seenDuringCall: unknown = null;
    const inner = f.deps.sender;
    f.deps.sender = {
      ...inner,
      async send(input) {
        // The ledger row and the draft state must exist before the provider is asked to send.
        seenDuringCall = { attempt: await one("select status, provider from send_attempts where organization_id = $1", [f.org]), draft: await one("select status from drafts where organization_id = $1", [f.org]) };
        return inner.send(input);
      },
    };
    const result = await send(f);
    expect(result).toMatchObject({ status: "sent", replayed: false });
    expect(seenDuringCall).toEqual({ attempt: { status: "sending", provider: "linkedin" }, draft: { status: "sending" } });
    expect(f.fake.messages).toHaveLength(1);
    expect(f.fake.messages[0]).toMatchObject({ text: "Happy to share more.", chat: f.input.providerThreadId });
    expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "sent" });
    expect(await one("select status from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "sent" });
    const out = await one("select * from messages where organization_id = $1 and direction = 'outbound'", [f.org]);
    expect(out).toMatchObject({ channel: "linkedin", account_ref: f.account, body_text: "Happy to share more.", to_address: "Ada Lovelace" });
    expect(await one("select workflow_state from records where organization_id = $1", [f.org])).toMatchObject({ workflow_state: "waiting" });
  });

  it("sends once for a double click with the same key, and for two clicks racing", async () => {
    const f = await fixture();
    const k = key();
    const results = await Promise.all([send(f, "Once only", k), send(f, "Once only", k), send(f, "Once only", k)]);
    expect(f.fake.messages).toHaveLength(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count("send_attempts", f.org)).toBe(1);
    // A click after the first finished replays the stored outcome.
    expect(await send(f, "Once only", k)).toMatchObject({ status: "sent", replayed: true });
    expect(f.fake.messages).toHaveLength(1);
  });

  it("lets only one of two workers with different keys send while the first is in flight", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const inner = f.deps.sender;
    const slow: LinkedInReplySender = { ...inner, send: async (input) => { calls += 1; await gate; return inner.send(input); } };
    const first = app.sendLinkedInReply({ ...f.deps, sender: slow }, f.actor, f.conversationId, { text: "First", idempotencyKey: key() });
    // Wait until the first holds its claim.
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    await expect(send(f, "Second", key())).rejects.toBeInstanceOf(ConflictError);
    release();
    expect(await first).toMatchObject({ status: "sent" });
    expect(f.fake.messages.map((m) => m.text)).toEqual(["First"]);
    // Once it finished, a new message is a new decision.
    expect(await send(f, "Third")).toMatchObject({ status: "sent" });
    expect(f.fake.messages).toHaveLength(2);
  });

  it("ends a lost response in delivery_uncertain, never resends, and reconcile finds the delivered message", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => "timeout-after-accept";
    const k = key();
    const result = await send(f, "Did this arrive?", k);
    expect(result).toMatchObject({ status: "delivery_uncertain" });
    expect(f.fake.messages).toHaveLength(1);
    expect(await one("select status from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "delivery_uncertain" });

    // The same key replays; a new key is refused until a person settles it. The provider is not called again.
    expect(await send(f, "Did this arrive?", k)).toMatchObject({ status: "delivery_uncertain", replayed: true });
    await expect(send(f, "Did this arrive?", key())).rejects.toBeInstanceOf(ConflictError);
    expect(f.fake.messages).toHaveLength(1);

    // Too fresh to look at, then old enough: the chat holds the message.
    expect(await app.reconcileLinkedInReplies(f.deps)).toMatchObject({ checked: 0 });
    await age(f, 11);
    const report = await app.reconcileLinkedInReplies(f.deps);
    expect(report).toMatchObject({ found: 1 });
    expect(await one("select status, reconciliation_note from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "reconciled" });
    expect(await count("messages", f.org, "direction = 'outbound'")).toBe(1);
    expect(f.fake.messages).toHaveLength(1);
  });

  it("keeps an unprovable send for a person, who can mark it not delivered and send again", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => "timeout-lost";
    expect(await send(f, "Lost one")).toMatchObject({ status: "delivery_uncertain" });
    expect(f.fake.messages).toHaveLength(0);
    await age(f, 11);
    // Already uncertain: reconcile looks, finds nothing, and does not change or resend it.
    expect(await app.reconcileLinkedInReplies(f.deps)).toMatchObject({ checked: 1, found: 0 });
    expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "delivery_uncertain" });
    expect(f.fake.messages).toHaveLength(0);

    const draft = await one("select id from drafts where organization_id = $1", [f.org]);
    await resolveApp.resolveUncertainSend({ store: replyStore, now: () => new Date() } as never, f.actor, draft.id, { outcome: "not_delivered", note: "Not in the chat on LinkedIn." });
    f.fake.messageBehavior = () => "ok";
    expect(await send(f, "Lost one")).toMatchObject({ status: "sent" });
    expect(f.fake.messages).toHaveLength(1);
  });

  it("settles an uncertain send a person confirms as delivered, as a LinkedIn message", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => "timeout-lost";
    await send(f, "Confirm me");
    const draft = await one("select id from drafts where organization_id = $1", [f.org]);
    await resolveApp.resolveUncertainSend({ store: replyStore, now: () => new Date() } as never, f.actor, draft.id, { outcome: "delivered", note: "Saw it in the chat." });
    expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "reconciled" });
    expect(await one("select channel, body_text from messages where organization_id = $1 and direction = 'outbound'", [f.org])).toMatchObject({ channel: "linkedin", body_text: "Confirm me" });
  });

  it("does not hand LinkedIn attempts to the email reconciler", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => "timeout-lost";
    await send(f, "Not email");
    await age(f, 40);
    const items = await replyStore.listUnsettled(new Date(), 100);
    expect(items.filter((i) => i.send.organizationId === f.org)).toHaveLength(0);
  });

  it("pauses the account on a rate-limit refusal, keeps the text, and refuses further replies without calling LinkedIn", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => ({ refuse: "rate_limited" });
    const refused = await send(f, "Too much");
    expect(refused).toMatchObject({ status: "failed" });
    const account = await one("select limit_reached_until, status from linkedin_accounts where id = $1", [f.account]);
    expect(account.status).toBe("connected");
    expect(new Date(account.limit_reached_until).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await one("select status, edited_body_text from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "awaiting_review", edited_body_text: "Too much" });
    expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "failed" });

    f.fake.messageBehavior = () => "ok";
    await expect(send(f, "Try again")).rejects.toMatchObject({ details: { code: "paused" } });
    expect(f.fake.messages).toHaveLength(0);
    const panel = await app.getLinkedInReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel?.issue).toMatch(/limited this account/);
    expect(panel?.draft).toMatchObject({ status: "awaiting_review", text: "Too much" });

    // The pause ends: the open draft takes the new text and goes out.
    await sql`update linkedin_accounts set limit_reached_until = now() - interval '1 minute' where id = ${f.account}`;
    expect(await send(f, "Try again")).toMatchObject({ status: "sent" });
    expect(await count("drafts", f.org)).toBe(1);
  });

  it("disconnects the account on an auth refusal", async () => {
    const f = await fixture();
    f.fake.messageBehavior = () => ({ refuse: "auth" });
    expect(await send(f)).toMatchObject({ status: "failed" });
    expect((await one("select status from linkedin_accounts where id = $1", [f.account])).status).toBe("disconnected");
    await expect(send(f)).rejects.toMatchObject({ details: { code: "not_connected" } });
  });

  it("applies the daily message cap and the gap between replies", async () => {
    const f = await fixture();
    await sql`update linkedin_accounts set daily_message_limit = 2 where id = ${f.account}`;
    expect(await send(f, "One")).toMatchObject({ status: "sent" });
    expect(await send(f, "Two")).toMatchObject({ status: "sent" });
    await expect(send(f, "Three")).rejects.toMatchObject({ details: { code: "daily_cap" } });
    expect(f.fake.messages).toHaveLength(2);

    const g = await fixture({ gap: 30 });
    expect(await send(g, "One")).toMatchObject({ status: "sent" });
    await expect(send(g, "Two")).rejects.toMatchObject({ details: { code: "too_fast", retryAfterSeconds: expect.any(Number) } });
    expect(g.fake.messages).toHaveLength(1);
  });

  it("refuses a person marked do not contact after the claim, before the call", async () => {
    const f = await fixture();
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${f.personId}, ${f.org}, true, 'human', now())`;
    expect(await send(f)).toMatchObject({ status: "blocked" });
    expect(f.fake.messages).toHaveLength(0);
    expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "failed" });
    const panel = await app.getLinkedInReplyPanel(f.deps, f.actor, f.conversationId);
    expect(panel?.doNotContact).toBe(true);
  });

  it("rejects empty text and an oversized message before any claim", async () => {
    const f = await fixture();
    await expect(send(f, "   ")).rejects.toThrow(/empty/);
    await expect(send(f, "x".repeat(8001))).rejects.toThrow(/longer/);
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("keeps organizations apart", async () => {
    const a = await fixture();
    const b = await fixture();
    // Organization B's member cannot reply, read the panel or reuse a key in A's chat.
    await expect(app.sendLinkedInReply(b.deps, b.actor, a.conversationId, { text: "Hi", idempotencyKey: key() })).rejects.toBeInstanceOf(NotFoundError);
    expect(await app.getLinkedInReplyPanel(b.deps, b.actor, a.conversationId)).toBeNull();
    expect(a.fake.messages).toHaveLength(0);
    expect(b.fake.messages).toHaveLength(0);
    const k = key();
    await send(a, "Mine", k);
    await expect(app.sendLinkedInReply(b.deps, b.actor, b.conversationId, { text: "Mine", idempotencyKey: k })).rejects.toBeInstanceOf(ConflictError);
    expect(await unread.counts(b.org)).toMatchObject({ linkedin: 1 });
  });

  it("refuses an email conversation and shows no composer for it", async () => {
    const f = await fixture();
    const [email] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id)
      select organization_id, record_id, 'email', 'me@corp.test', 'thread-x' from conversations where id = ${f.conversationId} returning id`;
    await expect(app.sendLinkedInReply(f.deps, f.actor, email.id, { text: "Hi", idempotencyKey: key() })).rejects.toBeInstanceOf(ConflictError);
    expect(await app.getLinkedInReplyPanel(f.deps, f.actor, email.id)).toBeNull();
    expect(f.fake.messages).toHaveLength(0);
  });

  it("counts unread LinkedIn replies and drops the count when the thread is opened", async () => {
    const f = await fixture();
    expect(await unread.counts(f.org)).toEqual({ total: 1, linkedin: 1, email: 0 });
    await send(f);
    expect(await unread.counts(f.org)).toMatchObject({ linkedin: 1 });
    await inboxApp.markConversationRead({ store: (await import("../drizzle-inbox-store")).drizzleInboxStore, now: () => new Date() }, f.actor, f.conversationId);
    expect(await unread.counts(f.org)).toEqual({ total: 0, linkedin: 0, email: 0 });
  });

  it("shows the reply in the thread", async () => {
    const f = await fixture();
    await send(f, "In the thread");
    const thread = await inboxApp.getThread({ store: (await import("../drizzle-inbox-store")).drizzleInboxStore, now: () => new Date() }, f.actor, f.conversationId);
    expect(thread.messages.filter((m) => m.direction === "outbound").map((m) => m.bodyText)).toContain("In the thread");
  });
  describe("attempt status guard", () => {
    async function claimed(f: Fx) {
      const r = await store.begin({ organizationId: f.org, conversationId: f.conversationId, text: "Guard me", idempotencyKey: key(), actorUserId: f.user, now: new Date() });
      if (r.kind !== "started") throw new Error("claim did not start");
      return r.send;
    }
    const state = async (f: Fx) => ({
      attempt: (await one("select status from send_attempts where organization_id = $1", [f.org])).status,
      draft: (await one("select status from drafts where organization_id = $1", [f.org])).status,
    });

    it("keeps a sent attempt sent when a late markFailed or markUncertain arrives", async () => {
      const f = await fixture();
      const ctx = await claimed(f);
      await store.markSent(ctx, { providerMessageId: "p1" }, new Date());
      await store.markFailed(ctx, "late failure");
      await store.markUncertain(ctx, "late timeout");
      expect(await state(f)).toEqual({ attempt: "sent", draft: "sent" });
      expect(await one("select error from send_attempts where organization_id = $1", [f.org])).toMatchObject({ error: null });
      expect(await count("messages", f.org, "direction = 'outbound'")).toBe(1);
    });

    it("keeps a reconciled attempt reconciled", async () => {
      const f = await fixture();
      const ctx = await claimed(f);
      await store.markUncertain(ctx, "timeout");
      await store.markSent(ctx, { providerMessageId: "p2" }, new Date(), "found in the chat");
      await store.markFailed(ctx, "late failure");
      await store.markUncertain(ctx, "late timeout");
      expect(await state(f)).toEqual({ attempt: "reconciled", draft: "sent" });
    });

    it("lets delivery_uncertain stay or settle, but a late definite failure changes nothing", async () => {
      const f = await fixture();
      const ctx = await claimed(f);
      await store.markUncertain(ctx, "timeout");
      await store.markFailed(ctx, "late failure");
      await store.markUncertain(ctx, "again");
      expect(await state(f)).toEqual({ attempt: "delivery_uncertain", draft: "delivery_uncertain" });
    });

    it("keeps a failed attempt failed: a late markSent or markUncertain changes nothing", async () => {
      const f = await fixture();
      const ctx = await claimed(f);
      await store.markFailed(ctx, "refused");
      await store.markUncertain(ctx, "late timeout");
      await store.markSent(ctx, { providerMessageId: "p3" }, new Date());
      expect(await state(f)).toEqual({ attempt: "failed", draft: "awaiting_review" });
      expect(await count("messages", f.org, "direction = 'outbound'")).toBe(0);
    });

    it("settles concurrent markSent and markFailed to exactly one final state", async () => {
      const f = await fixture();
      const ctx = await claimed(f);
      await Promise.all([store.markSent(ctx, { providerMessageId: "p4" }, new Date()), store.markFailed(ctx, "race"), store.markUncertain(ctx, "race")]);
      const { attempt, draft } = await state(f);
      expect(["sent", "failed", "delivery_uncertain"]).toContain(attempt);
      // The draft follows the attempt, whichever write won.
      expect(draft).toBe(attempt === "sent" ? "sent" : attempt === "failed" ? "awaiting_review" : "delivery_uncertain");
      expect(await count("messages", f.org, "direction = 'outbound'")).toBe(attempt === "sent" ? 1 : 0);
    });
  });
});
