import { afterAll, beforeAll, expect, it } from "vitest";
import type { InboundEmailInput } from "../../application/ports";
import type { FakeMailboxProvider } from "@/contexts/outreach/email/infrastructure/fake-mailbox-provider";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

describeDb("manual email replies (no AI)", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 6 });
  let composition: typeof import("../composition");
  let mgmt: typeof import("../../application/reply-management");
  let FakeAi: typeof import("../../ai/infrastructure/fake-reply-ai").FakeReplyAi;
  let store: typeof import("../drizzle-reply-store").drizzleReplyStore;
  let createReplyMailer: typeof import("../reply-mailer").createReplyMailer;
  let mailbox: FakeMailboxProvider;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Manual");
    orgs.push(created);
    const { organizationId: org, userId: user } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = new FakeAi();
    const replyDeps = {
      store,
      // The fake answers for this organization, so any AI call from the manual path shows up in its counters.
      ai: replyAiResolverOf(async () => ai),
      mailer: createReplyMailer(() => mailbox),
      now: () => new Date(),
      newToken: () => `tok-${Math.random().toString(36).slice(2)}`,
    };
    const n = ++counter;
    const input: InboundEmailInput = {
      organizationId: org,
      accountRef: address,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${tag}@acme.test`, name: "Lena Lead" },
      to: [address],
      subject: "Question about pricing",
      bodyText: "Could you send pricing?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
    };
    // Ingest only. No AI tick runs, so no draft exists and the classifier is never called.
    const ingested = await composition.ingestInbound(input);
    return { org, actor, address, ai, replyDeps, input, conversationId: ingested.conversationId, lead: input.from.email, tag };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);
  const key = () => `key-${Math.random().toString(36).slice(2)}`;
  const compose = (f: Fx, over: Partial<{ subject: string | null; bodyText: string; cc: string[] }> = {}) =>
    mgmt.createManualDraft(f.replyDeps, f.actor, f.conversationId, { subject: "Re: Question about pricing", bodyText: "Hi Lena, pricing is attached.", ...over });

  beforeAll(async () => {
    composition = await import("../composition");
    mgmt = await import("../../application/reply-management");
    store = (await import("../drizzle-reply-store")).drizzleReplyStore;
    FakeAi = (await import("../../ai/infrastructure/fake-reply-ai")).FakeReplyAi;
    createReplyMailer = (await import("../reply-mailer")).createReplyMailer;
    mailbox = (await import("@/contexts/outreach/infrastructure/composition")).mailboxProvider() as FakeMailboxProvider;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("creates an awaiting_review manual draft for the current context version, with no AI call", async () => {
    const f = await fixture();
    const created = await compose(f);
    const row = await one("select * from drafts where id = $1", [created.draftId]);
    expect(row).toMatchObject({ status: "awaiting_review", channel: "email", revision: 1, subject: "Re: Question about pricing", provider: "manual", ai_body_text: null, edited_body_text: "Hi Lena, pricing is attached." });
    expect(row.request).toMatchObject({ source: "manual", createdBy: f.actor.userId });
    const record = await one("select context_version, latest_inbound_message_id from records where organization_id = $1", [f.org]);
    expect(row.expected_context_version).toBe(record.context_version);
    expect(row.reply_for_message_id).toBe(record.latest_inbound_message_id);
    expect(await count("events", f.org, "event_type = 'draft.created_manual'")).toBe(1);
    expect(f.ai.classifyCalls + f.ai.draftCalls).toBe(0);

    const panel = (await mgmt.getReplyPanel(f.replyDeps, f.actor, f.conversationId))!;
    expect(panel.draft).toMatchObject({ id: created.draftId, source: "manual", status: "awaiting_review" });
    expect(panel.lastSubject).toBe("Question about pricing");
  });

  it("works when no AI key is configured", async () => {
    const f = await fixture();
    const deps = { ...f.replyDeps, ai: replyAiResolverOf(async () => null) };
    const created = await mgmt.createManualDraft(deps, f.actor, f.conversationId, { subject: "Hello", bodyText: "Body" });
    const sent = await mgmt.approveAndSendDraft(deps, f.actor, created.draftId, { revision: created.revision, idempotencyKey: key() });
    expect(sent).toMatchObject({ status: "sent" });
    await expect(mgmt.requestDraft(deps, f.actor, f.conversationId)).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires a subject and a body, and enforces the 998 and 100,000 limits", async () => {
    const f = await fixture();
    await expect(compose(f, { subject: "" })).rejects.toThrow(/subject is required/i);
    await expect(compose(f, { subject: "  \n " })).rejects.toThrow(/subject is required/i);
    await expect(compose(f, { subject: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(compose(f, { bodyText: "   " })).rejects.toThrow(/cannot be empty/i);
    await expect(compose(f, { subject: "s".repeat(999) })).rejects.toThrow(/998/);
    await expect(compose(f, { bodyText: "b".repeat(100_001) })).rejects.toThrow(/100000/);
    expect(await count("drafts", f.org)).toBe(0);
    const edge = await compose(f, { subject: "s".repeat(998), bodyText: "b".repeat(100_000) });
    expect(edge.revision).toBe(1);
    expect(await one("select length(subject)::int as subject, length(edited_body_text)::int as body, status from drafts where id = $1", [edge.draftId])).toEqual({ subject: 998, body: 100_000, status: "awaiting_review" });
    // An edit allows the same limits.
    await expect(mgmt.editDraft(f.replyDeps, f.actor, edge.draftId, { revision: 1, subject: "s".repeat(999), bodyText: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(mgmt.editDraft(f.replyDeps, f.actor, edge.draftId, { revision: 1, subject: "ok", bodyText: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("edits the draft with a revision check, then sends it once with claim and idempotency", async () => {
    const f = await fixture();
    const { draftId, revision } = await compose(f);
    const edited = await mgmt.editDraft(f.replyDeps, f.actor, draftId, { revision, subject: "Re: Pricing", bodyText: "Edited text" });
    expect(edited.revision).toBe(2);
    await expect(mgmt.editDraft(f.replyDeps, f.actor, draftId, { revision, bodyText: "stale edit" })).rejects.toBeInstanceOf(ConflictError);
    // The old revision cannot be approved.
    await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision, idempotencyKey: key() })).rejects.toBeInstanceOf(ConflictError);

    const before = mailbox.delivered.length;
    const k = key();
    const first = await mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision: 2, idempotencyKey: k });
    expect(first).toMatchObject({ status: "sent", replayed: false });
    expect(mailbox.delivered.length).toBe(before + 1);
    const sent = mailbox.delivered.at(-1)!;
    expect(sent).toMatchObject({ to: f.lead, subject: "Re: Pricing", bodyText: "Edited text", inReplyTo: f.input.rfcMessageId, threadId: f.input.providerThreadId });

    const again = await mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision: 2, idempotencyKey: k });
    expect(again).toMatchObject({ status: "sent", replayed: true });
    expect(mailbox.delivered.length).toBe(before + 1);
    await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision: 2, idempotencyKey: key() })).rejects.toBeInstanceOf(ConflictError);
    expect(await count("send_attempts", f.org)).toBe(1);
    expect(await one("select status from drafts where id = $1", [draftId])).toMatchObject({ status: "sent" });
    const out = await one("select body_text, subject from messages where organization_id = $1 and direction = 'outbound'", [f.org]);
    expect(out).toMatchObject({ body_text: "Edited text", subject: "Re: Pricing" });
    expect(f.ai.classifyCalls + f.ai.draftCalls).toBe(0);
  });

  it("concurrent approvals with different keys send once", async () => {
    const f = await fixture();
    const { draftId, revision } = await compose(f);
    const before = mailbox.delivered.length;
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => mgmt.approveAndSendDraft(f.replyDeps, f.actor, draftId, { revision, idempotencyKey: key() })));
    expect(mailbox.delivered.length).toBe(before + 1);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.status === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(await count("send_attempts", f.org)).toBe(1);
  });

  it("concurrent creates leave one open draft", async () => {
    const f = await fixture();
    await Promise.all([1, 2, 3].map((n) => compose(f, { bodyText: `Take ${n}` })));
    expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    expect(await count("drafts", f.org, "status = 'stale'")).toBe(2);
  });

  it("a new manual draft supersedes an open AI draft and the panel shows the new one", async () => {
    const f = await fixture();
    const record = await one("select id, context_version from records where organization_id = $1", [f.org]);
    const ai = await store.insertDraft({
      organizationId: f.org,
      recordId: record.id,
      conversationId: f.conversationId,
      replyForMessageId: null,
      expectedContextVersion: record.context_version,
      subject: "Re: AI",
      bodyText: "AI text",
      provider: "fake",
      model: "fake-1",
      request: {},
      response: {},
      citations: [],
    });
    const created = await compose(f);
    expect(await one("select status from drafts where id = $1", [ai.id])).toMatchObject({ status: "stale" });
    expect((await mgmt.getReplyPanel(f.replyDeps, f.actor, f.conversationId))!.draft?.id).toBe(created.draftId);
  });

  it("refuses a do-not-contact person and a suppressed address at creation", async () => {
    const dnc = await fixture();
    const person = await one("select id from people where organization_id = $1", [dnc.org]);
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${person.id}, ${dnc.org}, true, 'human', now())`;
    await expect(compose(dnc)).rejects.toThrow(/do not contact/i);
    expect(await count("drafts", dnc.org)).toBe(0);

    const sup = await fixture();
    await sql`insert into suppression_list (organization_id, email, reason) values (${sup.org}, ${sup.lead}, 'unsubscribed')`;
    await expect(compose(sup)).rejects.toThrow(/suppression list/i);
    expect(await count("drafts", sup.org)).toBe(0);
  });

  it("refuses at send time when the lead is suppressed or marked do-not-contact after the draft was written", async () => {
    const sup = await fixture();
    const a = await compose(sup);
    await sql`insert into suppression_list (organization_id, email, reason) values (${sup.org}, ${sup.lead}, 'unsubscribed')`;
    const before = mailbox.delivered.length;
    expect(await mgmt.approveAndSendDraft(sup.replyDeps, sup.actor, a.draftId, { revision: a.revision, idempotencyKey: key() })).toMatchObject({ status: "blocked" });
    expect(mailbox.delivered.length).toBe(before);
    expect(await one("select status from send_attempts where draft_id = $1", [a.draftId])).toMatchObject({ status: "failed" });

    const dnc = await fixture();
    const b = await compose(dnc);
    const person = await one("select id from people where organization_id = $1", [dnc.org]);
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${person.id}, ${dnc.org}, true, 'human', now())`;
    expect(await mgmt.approveAndSendDraft(dnc.replyDeps, dnc.actor, b.draftId, { revision: b.revision, idempotencyKey: key() })).toMatchObject({ status: "blocked" });
    expect(mailbox.delivered.length).toBe(before);
  });

  it("applies the CC model: known addresses only, blocked ones refused, chosen CCs reach the mailbox", async () => {
    const f = await fixture();
    const person = await one("select id from people where organization_id = $1", [f.org]);
    const boss = `boss-${f.tag}@acme.test`;
    const blocked = `blocked-${f.tag}@acme.test`;
    await sql`insert into lead_ccs (organization_id, person_id, email, last_seen_at) values (${f.org}, ${person.id}, ${boss}, now()), (${f.org}, ${person.id}, ${blocked}, now())`;
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${blocked}, 'unsubscribed')`;

    await expect(compose(f, { cc: ["stranger@nowhere.test"] })).rejects.toThrow(/has not been on this lead's mail/);
    await expect(compose(f, { cc: [blocked] })).rejects.toBeInstanceOf(ConflictError);
    await expect(compose(f, { cc: ["not-an-email"] })).rejects.toBeInstanceOf(ValidationError);
    expect(await count("drafts", f.org)).toBe(0);

    const created = await compose(f, { cc: [boss] });
    expect((await one("select cc from drafts where id = $1", [created.draftId])).cc).toEqual([boss]);
    await mgmt.approveAndSendDraft(f.replyDeps, f.actor, created.draftId, { revision: created.revision, idempotencyKey: key() });
    expect(mailbox.delivered.at(-1)!.cc).toEqual([boss]);

    // A CC that becomes suppressed after the draft was written blocks the send, and the draft stays editable.
    const second = await compose(f, { cc: [boss] });
    await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${boss}, 'unsubscribed')`;
    const before = mailbox.delivered.length;
    expect(await mgmt.approveAndSendDraft(f.replyDeps, f.actor, second.draftId, { revision: second.revision, idempotencyKey: key() })).toMatchObject({ status: "blocked" });
    expect(mailbox.delivered.length).toBe(before);
    expect(await one("select status from drafts where id = $1", [second.draftId])).toMatchObject({ status: "awaiting_review" });
  });

  it("answers 404 for another organization's conversation and draft", async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(mgmt.createManualDraft(b.replyDeps, b.actor, a.conversationId, { subject: "Hi", bodyText: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(mgmt.createManualDraft(b.replyDeps, b.actor, a.conversationId, { subject: "Hi", bodyText: "x", cc: ["a@b.test"] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(mgmt.createManualDraft(b.replyDeps, b.actor, "not-a-uuid", { subject: "Hi", bodyText: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await count("drafts", a.org)).toBe(0);
    expect(await count("drafts", b.org)).toBe(0);

    const mine = await compose(a);
    await expect(mgmt.editDraft(b.replyDeps, b.actor, mine.draftId, { revision: 1, bodyText: "hijack" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(mgmt.approveAndSendDraft(b.replyDeps, b.actor, mine.draftId, { revision: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a closed conversation and a thread with a send in flight", async () => {
    const f = await fixture();
    const created = await compose(f);
    await sql`update drafts set status = 'sending' where id = ${created.draftId}`;
    await expect(compose(f)).rejects.toThrow("A reply is already being sent in this thread.");
    await sql`update drafts set status = 'delivery_uncertain' where id = ${created.draftId}`;
    await expect(compose(f)).rejects.toThrow("An earlier reply in this thread has an unconfirmed outcome. Check the mailbox and mark what you found first.");
    await sql`update drafts set status = 'awaiting_review' where id = ${created.draftId}`;
    await sql`update conversations set status = 'closed' where id = ${f.conversationId}`;
    await expect(compose(f)).rejects.toThrow("This conversation is closed.");
  });

  it("checks for a reply in flight on the conversation, not on the record's other conversations", async () => {
    const f = await fixture();
    // A LinkedIn reply of the same person, sending in its own chat (docs/decisions.md, "Reply send rules").
    const [chat] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id)
      select organization_id, record_id, 'linkedin', ${crypto.randomUUID()}, ${"chat-" + f.tag} from conversations where id = ${f.conversationId} returning id`;
    await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, edited_body_text, status, provider)
      select organization_id, record_id, id, 1, 'linkedin', 'On its way', 'sending', 'human' from conversations where id = ${chat.id}`;
    const created = await compose(f);
    expect(await one("select status, conversation_id from drafts where id = $1", [created.draftId])).toMatchObject({ status: "awaiting_review", conversation_id: f.conversationId });
    await expect(mgmt.createManualDraft(f.replyDeps, f.actor, chat.id, { subject: "Hi", bodyText: "x" })).rejects.toThrow("This is not an email conversation.");
  });
});
