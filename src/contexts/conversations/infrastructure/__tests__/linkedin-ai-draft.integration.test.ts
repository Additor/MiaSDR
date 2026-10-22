import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundLinkedInInput } from "../../application/linkedin-ports";
import type { LinkedInReplyDeps } from "../../application/linkedin-reply";
import type { FakeLinkedInGateway } from "@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { buildDraftPrompt } from "../../ai/domain/prompts";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

describeDb("AI drafts for LinkedIn threads", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let composition: typeof import("../composition");
  let liApp: typeof import("../../application/linkedin-reply");
  let mgmt: typeof import("../../application/reply-management");
  let aiJobsApp: typeof import("../../ai/application/ai-jobs");
  let replyHandlingApp: typeof import("../../application/reply-handling");
  let knowledgeApp: typeof import("../../ai/application/knowledge");
  let stores: {
    jobs: typeof import("../../ai/infrastructure/drizzle-ai-job-store").drizzleAiJobStore;
    replies: typeof import("../drizzle-reply-store").drizzleReplyStore;
    li: typeof import("../drizzle-linkedin-reply-store").drizzleLinkedInReplyStore;
    knowledge: typeof import("../../ai/infrastructure/drizzle-knowledge-store").drizzleKnowledgeStore;
    crm: typeof import("../drizzle-reply-handling-store").drizzleReplyHandlingStore;
  };
  let FakeAi: typeof import("../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  let Fake: typeof import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway").FakeLinkedInGateway;
  let makeSender: typeof import("../linkedin-reply-sender").createLinkedInReplySender;
  let createReplyMailer: typeof import("../reply-mailer").createReplyMailer;
  let mailboxProvider: typeof import("@/contexts/outreach/infrastructure/composition").mailboxProvider;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture(opts: { ai?: boolean } = {}) {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "LI draft");
    orgs.push(created);
    const { organizationId: org, userId: user } = created;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-" + tag}, 'Jo Owner', 'connected') returning id`;
    await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql.json({ replyGapSeconds: 0 })})`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${`me-${tag}@corp.test`}, 'connected', 'Mia Rep')`;
    const fake: FakeLinkedInGateway = new Fake();
    const ai = opts.ai === false ? null : new FakeAi();
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const resolver = replyAiResolverOf(async (o: string) => (o === org ? ai : null));
    const clock = () => new Date();
    const [tick] = aiJobsApp.createAiJobs({ jobs: stores.jobs, replies: stores.replies, ai: resolver, now: clock, workerId: "t", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000 }) as [Job];
    const liDeps: LinkedInReplyDeps = { store: stores.li, sender: makeSender(fake), now: clock, aiStatus: resolver.status };
    const replyDeps = { store: stores.replies, ai: resolver, mailer: createReplyMailer(mailboxProvider), now: clock, newToken: () => `tok-${Math.random().toString(36).slice(2)}` };
    const replyHandlingDeps = { store: stores.crm, inbox: (await import("../drizzle-inbox-store")).drizzleInboxStore, now: clock, replay: { email: composition.ingestInbound, linkedin: composition.ingestInboundLinkedInMessage } };
    const n = ++counter;
    const input: InboundLinkedInInput = {
      organizationId: org,
      accountRef: account,
      accountName: "Jo Owner",
      providerThreadId: `chat-${tag}-${n}`,
      providerMessageId: `msg-${tag}-${n}`,
      counterparty: { providerId: `ACo-lead-${n}`, name: "Ada Lovelace", profileUrl: `https://www.linkedin.com/in/ada-${tag}`, slug: `ada-${tag}` },
      personId: null,
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date(Date.now() - 5000),
    };
    const ingested = await composition.ingestInboundLinkedInMessage(input);
    return { org, user, account: account as string, actor, fake, ai, liDeps, replyDeps, replyHandlingDeps, tag, input, conversationId: ingested.conversationId, personId: ingested.personId, run: () => tick.run({ deadline: Date.now() + 60_000, now: clock }) };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const key = () => `key-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);
  const panel = async (f: Fx) => (await liApp.getLinkedInReplyPanel(f.liDeps, f.actor, f.conversationId))!;
  /** Ingests the lead's message and runs the AI tick: classification, then the draft. */
  async function drafted(opts: { ai?: boolean } = {}) {
    const f = await fixture(opts);
    await f.run();
    return f;
  }
  const approve = async (f: Fx, text: string, k = key()) => {
    const p = await panel(f);
    return liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text, idempotencyKey: k, draftId: p.draft!.id, revision: p.draft!.revision });
  };

  beforeAll(async () => {
    composition = await import("../composition");
    liApp = await import("../../application/linkedin-reply");
    mgmt = await import("../../application/reply-management");
    aiJobsApp = await import("../../ai/application/ai-jobs");
    replyHandlingApp = await import("../../application/reply-handling");
    knowledgeApp = await import("../../ai/application/knowledge");
    stores = {
      jobs: (await import("../../ai/infrastructure/drizzle-ai-job-store")).drizzleAiJobStore,
      replies: (await import("../drizzle-reply-store")).drizzleReplyStore,
      li: (await import("../drizzle-linkedin-reply-store")).drizzleLinkedInReplyStore,
      knowledge: (await import("../../ai/infrastructure/drizzle-knowledge-store")).drizzleKnowledgeStore,
      crm: (await import("../drizzle-reply-handling-store")).drizzleReplyHandlingStore,
    };
    FakeAi = (await import("../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
    Fake = (await import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway")).FakeLinkedInGateway;
    makeSender = (await import("../linkedin-reply-sender")).createLinkedInReplySender;
    createReplyMailer = (await import("../reply-mailer")).createReplyMailer;
    mailboxProvider = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("the draft job", () => {
    it("writes a LinkedIn draft with no subject and gives the model the LinkedIn rules", async () => {
      const f = await drafted();
      expect(f.ai!.draftCalls).toBe(1);
      const input = f.ai!.lastDraftInput!;
      expect(input.channel).toBe("linkedin");
      expect(input.subject).toBe("");
      expect(input.senderName).toBe("Jo Owner");
      expect(input.person.name).toBe("Ada Lovelace");
      expect(input.thread.map((e) => e.text)).toEqual(["Could we book a demo next week?"]);
      expect(input.classification?.subcategoryName).toBe("Demo request");

      const prompt = buildDraftPrompt(input, "n1");
      expect(prompt.system).toMatch(/LinkedIn/);
      expect(prompt.system).toMatch(/no subject line/);
      expect(prompt.system).toContain("8000 characters");
      expect(prompt.system).not.toMatch(/Do not include a signature or an unsubscribe line/);
      expect(prompt.user).not.toContain("thread_subject");
      expect(prompt.user).not.toContain("subject:");
      expect(prompt.user).not.toContain("email:");

      const draft = await one("select * from drafts where organization_id = $1", [f.org]);
      expect(draft).toMatchObject({ channel: "linkedin", subject: null, status: "awaiting_review", provider: "fake" });
      expect(draft.ai_body_text).toMatch(/Ada/);
      // Nothing was sent by the job.
      expect(f.fake.messages).toHaveLength(0);
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("drops a subject the model returns and rejects a body over LinkedIn's limit", async () => {
      const f = await fixture();
      f.ai!.draftWith = () => ({ subject: "Re: demo", bodyText: "Happy to set that up." });
      await f.run();
      expect(await one("select subject, ai_body_text from drafts where organization_id = $1", [f.org])).toMatchObject({ subject: null, ai_body_text: "Happy to set that up." });

      const g = await fixture();
      g.ai!.draftWith = () => ({ bodyText: "x".repeat(8001) });
      await g.run();
      expect(await count("drafts", g.org)).toBe(0);
      expect(await one("select status, last_error from ai_jobs where organization_id = $1 and kind = 'initial_draft'", [g.org])).toMatchObject({ status: "queued" });
    });

    it("puts the stage move note and the matching knowledge in the prompt", async () => {
      const f = await drafted();
      await knowledgeApp.createKnowledge(stores.knowledge, { ...f.actor, role: "admin" }, { title: "Demo process", kind: "faq", content: "Demos run 30 minutes on Zoom.", alwaysInclude: true, tags: [] });
      const record = await one("select id, context_version from records where organization_id = $1", [f.org]);
      const target = await one("select id, category_key from subcategories where organization_id = $1 and key = 'meeting_done' limit 1", [f.org]);
      await replyHandlingApp.moveRecordStage(f.replyHandlingDeps, f.actor, record.id, { categoryKey: target.category_key, subcategoryId: target.id, expectedContextVersion: Number(record.context_version), note: "We met on a call, send the contract" });
      // The move retires the open draft; a person asks for a fresh one.
      expect(await count("drafts", f.org, "status = 'stale'")).toBe(1);
      await mgmt.requestDraft(f.replyDeps, f.actor, f.conversationId);
      const input = f.ai!.lastDraftInput!;
      expect(input.channel).toBe("linkedin");
      expect(input.stageChange?.note).toBe("We met on a call, send the contract");
      expect(input.knowledge.map((k) => k.title)).toContain("Demo process");
      expect(await count("drafts", f.org, "channel = 'linkedin' and subject is null and status = 'awaiting_review'")).toBe(1);
      expect(await count("drafts", f.org, "status = 'stale'")).toBe(1);
    });

    it("makes no draft for a do-not-contact person and none when AI is off", async () => {
      const f = await fixture();
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${f.personId}, ${f.org}, true, 'human', now())`;
      await f.run();
      expect(f.ai!.draftCalls).toBe(0);
      expect(await count("drafts", f.org)).toBe(0);

      const g = await drafted({ ai: false });
      expect(await count("drafts", g.org)).toBe(0);
      expect(await panel(g)).toMatchObject({ canGenerate: false, aiOff: "AI is off. Ask an owner or admin to connect an AI provider." });
    });
  });

  describe("regenerate and request on demand", () => {
    it("regenerates a LinkedIn draft on the LinkedIn channel and writes one on request when the job made none", async () => {
      const f = await drafted();
      const first = (await panel(f)).draft!;
      expect(first).toMatchObject({ source: "ai", status: "awaiting_review" });
      const regenerated = await mgmt.regenerateDraft(f.replyDeps, f.actor, first.id, { note: "shorter" });
      expect(f.ai!.lastDraftInput).toMatchObject({ channel: "linkedin", feedback: "shorter" });
      expect(await one("select channel, subject, status from drafts where id = $1", [regenerated.draftId])).toMatchObject({ channel: "linkedin", subject: null, status: "awaiting_review" });
      expect(await one("select status from drafts where id = $1", [first.id])).toMatchObject({ status: "discarded" });

      // Discarding leaves the thread without a draft; a request writes a new one.
      await mgmt.discardDraft(f.replyDeps, f.actor, regenerated.draftId);
      expect((await panel(f)).draft).toBeNull();
      expect((await panel(f)).canGenerate).toBe(true);
      const requested = await mgmt.requestDraft(f.replyDeps, f.actor, f.conversationId);
      expect(await one("select channel, subject from drafts where id = $1", [requested.draftId])).toMatchObject({ channel: "linkedin", subject: null });
    });
  });

  describe("approving the AI draft", () => {
    it("sends the edited text once through the gateway, and a replay sends nothing more", async () => {
      const f = await drafted();
      const k = key();
      const before = (await panel(f)).draft!;
      const first = await approve(f, "Thursday at 10 works. Sending an invite.", k);
      expect(first).toMatchObject({ status: "sent", replayed: false });
      expect(f.fake.messages).toHaveLength(1);
      expect(f.fake.messages[0]).toMatchObject({ text: "Thursday at 10 works. Sending an invite.", chat: f.input.providerThreadId });
      expect(await one("select status, provider, account_ref from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "sent", provider: "linkedin", account_ref: f.account });
      const draft = await one("select status, edited_body_text, ai_body_text, revision from drafts where organization_id = $1", [f.org]);
      expect(draft).toMatchObject({ status: "sent", edited_body_text: "Thursday at 10 works. Sending an invite." });
      expect(draft.ai_body_text).not.toBe(draft.edited_body_text);
      expect(await one("select workflow_state from records where organization_id = $1", [f.org])).toMatchObject({ workflow_state: "waiting" });

      // The same key again, as a lost response would trigger: the stored outcome comes back and nothing is sent.
      const again = await liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "ignored", idempotencyKey: k, draftId: before.id, revision: before.revision });
      expect(again).toMatchObject({ status: "sent", replayed: true });
      expect(f.fake.messages).toHaveLength(1);
    });

    it("replays the same key without a second send and ignores the second click's text", async () => {
      const f = await drafted();
      const p = await panel(f);
      const k = key();
      const input = { text: "Once only", idempotencyKey: k, draftId: p.draft!.id, revision: p.draft!.revision };
      const results = await Promise.all([1, 2, 3].map(() => liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, input)));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(f.fake.messages).toHaveLength(1);
      expect(await liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, input)).toMatchObject({ status: "sent", replayed: true });
      expect(f.fake.messages).toHaveLength(1);
      expect(await count("send_attempts", f.org)).toBe(1);
    });

    it("never touches the email path: the email approve refuses a LinkedIn draft and no mailbox attempt exists", async () => {
      const f = await drafted();
      const p = await panel(f);
      await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, p.draft!.id, { revision: p.draft!.revision, idempotencyKey: key() })).rejects.toBeInstanceOf(ConflictError);
      await approve(f, "Sounds good.");
      expect(await count("send_attempts", f.org, "provider = 'mailbox'")).toBe(0);
      expect(await count("send_attempts", f.org, "provider = 'linkedin'")).toBe(1);
      expect(await one("select channel from messages where organization_id = $1 and direction = 'outbound'", [f.org])).toMatchObject({ channel: "linkedin" });
    });

    it("refuses at the daily limit before any call, and keeps the draft for later", async () => {
      const f = await drafted();
      // The account allows one message a day and a typed reply used it.
      await sql`update linkedin_accounts set daily_message_limit = 1 where id = ${f.account}`;
      const [used] = await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, edited_body_text, status, provider)
        select organization_id, record_id, conversation_id, expected_context_version, 'linkedin', 'earlier reply', 'discarded', 'human' from drafts where organization_id = ${f.org} returning id`;
      await sql`insert into send_attempts (organization_id, draft_id, idempotency_key, status, provider, account_ref, actor_user_id, request)
        values (${f.org}, ${used.id}, ${key()}, 'sent', 'linkedin', ${f.account}, ${f.user}, '{}'::jsonb)`;
      await expect(approve(f, "Hello")).rejects.toMatchObject({ details: { code: "daily_cap" } });
      expect(f.fake.messages).toHaveLength(0);
      expect(await count("send_attempts", f.org)).toBe(1);
      expect(await one("select status from drafts where organization_id = $1 and status <> 'discarded'", [f.org])).toMatchObject({ status: "awaiting_review" });
      expect((await panel(f)).draft).toMatchObject({ status: "awaiting_review", source: "ai" });

      // The limit lifts: the same draft goes out.
      await sql`update linkedin_accounts set daily_message_limit = 50 where id = ${f.account}`;
      expect(await approve(f, "Hello")).toMatchObject({ status: "sent" });
      expect(f.fake.messages).toHaveLength(1);
    });

    it("respects the gap between replies and a rate-limit pause", async () => {
      const f = await drafted();
      await sql`update channel_settings set values = ${sql.json({ replyGapSeconds: 600 })} where organization_id = ${f.org} and channel = 'linkedin'`;
      expect(await approve(f, "First")).toMatchObject({ status: "sent" });
      const g = await mgmt.requestDraft(f.replyDeps, f.actor, f.conversationId);
      expect(await one("select channel, status from drafts where id = $1", [g.draftId])).toEqual({ channel: "linkedin", status: "awaiting_review" });
      await expect(approve(f, "Second")).rejects.toMatchObject({ details: { code: "too_fast" } });
      expect(f.fake.messages).toHaveLength(1);

      const h = await drafted();
      h.fake.messageBehavior = () => ({ refuse: "rate_limited" });
      expect(await approve(h, "Hi")).toMatchObject({ status: "failed" });
      expect(await one("select limit_reached_until from linkedin_accounts where id = $1", [h.account])).toMatchObject({ limit_reached_until: expect.any(Date) });
      expect(await one("select status from drafts where organization_id = $1", [h.org])).toMatchObject({ status: "awaiting_review" });
      await expect(approve(h, "Hi again")).rejects.toMatchObject({ details: { code: "paused" } });
    });

    it("refuses a do-not-contact person at approval and sends nothing", async () => {
      const f = await drafted();
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${f.personId}, ${f.org}, true, 'human', now())`;
      const result = await approve(f, "Hello");
      expect(result).toMatchObject({ status: "blocked", error: expect.stringMatching(/do not contact/) });
      expect(f.fake.messages).toHaveLength(0);
      expect(await one("select status from send_attempts where organization_id = $1", [f.org])).toMatchObject({ status: "failed" });
      expect(await one("select status from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "awaiting_review" });
    });

    it("records an unknown outcome and refuses a second approval until a person settles it", async () => {
      const f = await drafted();
      f.fake.messageBehavior = () => "timeout-after-accept";
      const result = await approve(f, "Hello");
      expect(result).toMatchObject({ status: "delivery_uncertain" });
      expect(await one("select status from drafts where organization_id = $1", [f.org])).toMatchObject({ status: "delivery_uncertain" });
      expect((await panel(f)).draft).toMatchObject({ status: "delivery_uncertain" });
      f.fake.messageBehavior = () => "ok";
      await expect(liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "again", idempotencyKey: key() })).rejects.toBeInstanceOf(ConflictError);
      expect(f.fake.messages).toHaveLength(1);
    });
  });

  describe("stale and changed drafts", () => {
    it("turns the draft stale when the lead writes again, and refuses to send it", async () => {
      const f = await drafted();
      const p = await panel(f);
      await composition.ingestInboundLinkedInMessage({ ...f.input, providerMessageId: `${f.input.providerMessageId}-2`, bodyText: "Actually, can we do Friday instead?", receivedAt: new Date() });
      expect(await one("select status from drafts where id = $1", [p.draft!.id])).toMatchObject({ status: "stale" });
      expect((await panel(f)).draft).toMatchObject({ id: p.draft!.id, status: "stale" });
      await expect(liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "old answer", idempotencyKey: key(), draftId: p.draft!.id, revision: p.draft!.revision })).rejects.toBeInstanceOf(ConflictError);
      expect(f.fake.messages).toHaveLength(0);
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("marks a draft stale when the record moved on before the stale sweep ran", async () => {
      const f = await drafted();
      const p = await panel(f);
      await sql`update records set context_version = context_version + 1 where organization_id = ${f.org}`;
      await expect(liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "x", idempotencyKey: key(), draftId: p.draft!.id, revision: p.draft!.revision })).rejects.toBeInstanceOf(ConflictError);
      expect(await one("select status from drafts where id = $1", [p.draft!.id])).toMatchObject({ status: "stale" });
      expect(f.fake.messages).toHaveLength(0);
    });

    it("refuses a revision the person did not review, and a draft from another conversation", async () => {
      const f = await drafted();
      const p = await panel(f);
      await expect(liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "x", idempotencyKey: key(), draftId: p.draft!.id, revision: p.draft!.revision + 1 })).rejects.toBeInstanceOf(ConflictError);
      const other = await drafted();
      const o = await panel(other);
      await expect(liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "x", idempotencyKey: key(), draftId: o.draft!.id, revision: o.draft!.revision })).rejects.toBeInstanceOf(NotFoundError);
      expect(f.fake.messages).toHaveLength(0);
      expect(other.fake.messages).toHaveLength(0);
    });

    it("lets the person regenerate a stale draft, and the fresh draft sends", async () => {
      const f = await drafted();
      const p = await panel(f);
      await composition.ingestInboundLinkedInMessage({ ...f.input, providerMessageId: `${f.input.providerMessageId}-3`, bodyText: "Friday works better", receivedAt: new Date() });
      const regenerated = await mgmt.regenerateDraft(f.replyDeps, f.actor, p.draft!.id, {});
      const fresh = (await panel(f)).draft!;
      expect(fresh.id).toBe(regenerated.draftId);
      expect(await approve(f, "Friday it is.")).toMatchObject({ status: "sent" });
      expect(f.fake.messages.map((m) => m.text)).toEqual(["Friday it is."]);
    });
  });

  describe("tenancy and the typed composer", () => {
    it("answers 404 across organizations for the panel, regenerate, discard and the send", async () => {
      const a = await drafted();
      const b = await drafted();
      const p = await panel(a);
      await expect(liApp.getLinkedInReplyPanel(b.liDeps, b.actor, a.conversationId)).resolves.toBeNull();
      await expect(liApp.sendLinkedInReply(b.liDeps, b.actor, a.conversationId, { text: "x", idempotencyKey: key(), draftId: p.draft!.id, revision: p.draft!.revision })).rejects.toBeInstanceOf(NotFoundError);
      await expect(mgmt.regenerateDraft(b.replyDeps, b.actor, p.draft!.id, {})).rejects.toBeInstanceOf(NotFoundError);
      await expect(mgmt.discardDraft(b.replyDeps, b.actor, p.draft!.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(mgmt.requestDraft(b.replyDeps, b.actor, a.conversationId)).rejects.toBeInstanceOf(NotFoundError);
      expect(a.fake.messages).toHaveLength(0);
      expect(b.fake.messages).toHaveLength(0);
      expect(await one("select status from drafts where id = $1", [p.draft!.id])).toMatchObject({ status: "awaiting_review" });
    });

    it("keeps the typed composer working with no AI, and with an AI draft open", async () => {
      const none = await drafted({ ai: false });
      expect((await panel(none)).draft).toBeNull();
      expect(await liApp.sendLinkedInReply(none.liDeps, none.actor, none.conversationId, { text: "Typed by hand", idempotencyKey: key() })).toMatchObject({ status: "sent" });
      expect(none.fake.messages.map((m) => m.text)).toEqual(["Typed by hand"]);
      expect(none.ai).toBeNull();

      const f = await drafted();
      // No draftId: the typed text goes out and takes the open draft's place.
      expect(await liApp.sendLinkedInReply(f.liDeps, f.actor, f.conversationId, { text: "My own words", idempotencyKey: key() })).toMatchObject({ status: "sent" });
      expect(f.fake.messages.map((m) => m.text)).toEqual(["My own words"]);
      expect(await count("drafts", f.org, "status = 'sent'")).toBe(1);
      expect((await panel(f)).draft).toBeNull();
    });

    it("keeps the email draft job and manual email composer working for an email thread of the same shape", async () => {
      const f = await fixture();
      const address = (await one("select email_address from mailboxes where organization_id = $1", [f.org])).email_address as string;
      const n = ++counter;
      await composition.ingestInbound({
        organizationId: f.org,
        accountRef: address,
        providerThreadId: `thread-e-${n}`,
        providerMessageId: `msg-e-${n}`,
        rfcMessageId: `<e${n}@lead.test>`,
        inReplyTo: null,
        from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
        to: [address],
        subject: "Re: hello",
        bodyText: "Could we book a demo next week?",
        receivedAt: new Date(Date.now() - 4000),
        autoReply: false,
      });
      await f.run();
      expect(await count("drafts", f.org, "channel = 'email' and subject is not null and status = 'awaiting_review'")).toBe(1);
      expect(f.ai!.draftCalls).toBe(2);
      expect(await count("drafts", f.org, "channel = 'linkedin' and subject is null and status = 'awaiting_review'")).toBe(1);
      const email = await one("select c.id from conversations c where c.organization_id = $1 and c.channel = 'email'", [f.org]);
      const manual = await mgmt.createManualDraft(f.replyDeps, f.actor, email.id, { subject: "Re: hello", bodyText: "By hand." });
      expect(manual.revision).toBe(1);
      // The manual email draft leaves the LinkedIn draft of this organization alone.
      expect(await count("drafts", f.org, "channel = 'linkedin' and status = 'awaiting_review'")).toBe(1);
      await expect(mgmt.createManualDraft(f.replyDeps, f.actor, f.conversationId, { subject: "x", bodyText: "y" })).rejects.toBeInstanceOf(ConflictError);
    });

    it("a typed email draft leaves an open LinkedIn draft of the same record alone, and supersedes an open email draft", async () => {
      const f = await fixture();
      await f.run();
      const address = (await one("select email_address from mailboxes where organization_id = $1", [f.org])).email_address as string;
      const n = ++counter;
      await composition.ingestInbound({
        organizationId: f.org,
        accountRef: address,
        providerThreadId: `thread-s-${n}`,
        providerMessageId: `msg-s-${n}`,
        rfcMessageId: `<s${n}@lead.test>`,
        inReplyTo: null,
        from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
        to: [address],
        subject: "Re: hello",
        bodyText: "Could we book a demo next week?",
        receivedAt: new Date(Date.now() - 4000),
        autoReply: false,
      });
      const email = await one("select c.id, c.record_id from conversations c where c.organization_id = $1 and c.channel = 'email'", [f.org]);
      // One person on two channels: the LinkedIn draft belongs to the same record as the email thread.
      await sql`update drafts set record_id = ${email.record_id}, expected_context_version = (select context_version from records where id = ${email.record_id}) where organization_id = ${f.org} and channel = 'linkedin'`;
      expect(await count("drafts", f.org, "channel = 'linkedin' and status = 'awaiting_review'")).toBe(1);
      const first = await mgmt.createManualDraft(f.replyDeps, f.actor, email.id, { subject: "Re: hello", bodyText: "First by hand." });
      expect(await count("drafts", f.org, "channel = 'linkedin' and status = 'awaiting_review'")).toBe(1);
      const second = await mgmt.createManualDraft(f.replyDeps, f.actor, email.id, { subject: "Re: hello", bodyText: "Second by hand." });
      expect((await one("select status from drafts where id = $1", [first.draftId])).status).toBe("stale");
      expect((await one("select status from drafts where id = $1", [second.draftId])).status).toBe("awaiting_review");
      expect(await count("drafts", f.org, "channel = 'linkedin' and status = 'awaiting_review'")).toBe(1);
    });
  });
});
