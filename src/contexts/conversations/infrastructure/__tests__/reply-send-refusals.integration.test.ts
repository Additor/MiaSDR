import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundLinkedInInput } from "../../application/linkedin-ports";
import type { LinkedInReplyDeps } from "../../application/linkedin-reply";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { useReplyKit, type ReplyFixture, type ReplyModules } from "./replies-test-kit";

/**
 * Characterization of every reason a reply send is refused before the provider call, per channel: the status the route
 * answers and its `error` text. The reply send rules refactor changes these only where it means to. In-flight refusals
 * stay out: another change rewrites them. linkedin-reply.integration.test.ts covers the LinkedIn account blocks
 * (paused, not connected, daily cap, gap), do not contact, and empty or oversized text.
 */

const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

/**
 * What `withActor` (src/app/_lib/api.ts) answers for an error the use case throws: the status, the `error` text, and the
 * details or issues. It maps only the use-case errors (404, 409, 422). The route's own zod parse, which answers 400
 * "Invalid input" before the use case runs, stays out of these tests.
 */
async function refusal(run: Promise<unknown>): Promise<Record<string, unknown>> {
  let thrown: unknown;
  try {
    await run;
  } catch (error) {
    thrown = error;
  }
  if (thrown instanceof NotFoundError) return { status: 404, error: thrown.message };
  if (thrown instanceof ConflictError) return { status: 409, error: thrown.message, ...thrown.details };
  if (thrown instanceof ValidationError) return { status: 422, error: thrown.message, issues: thrown.issues };
  throw new Error(thrown === undefined ? "The send was not refused." : `Unexpected error: ${String(thrown)}`);
}

describeDb("Email reply send refusals", () => {
  const { sql, modules, fixture, one, count, receive, panel, sendKey } = useReplyKit();
  let mgmt: ReplyModules["mgmt"];
  let mailbox: ReplyModules["mailbox"];
  let handling: typeof import("../../application/reply-handling");
  let handlingDeps: import("../../application/reply-handling").ReplyHandlingDeps;

  beforeAll(async () => {
    ({ mgmt, mailbox } = modules);
    handling = await import("../../application/reply-handling");
    handlingDeps = (await import("../reply-handling-composition")).replyHandlingDeps();
  });

  /** A reply with the AI draft awaiting review. */
  async function withDraft(f: ReplyFixture) {
    const r = await receive(f);
    const draft = (await panel(f, r.conversationId)).draft!;
    const { record_id: recordId } = await one("select record_id from conversations where id = $1", [r.conversationId]);
    return { r, draft, recordId: recordId as string };
  }
  const approve = (f: ReplyFixture, draft: { id: string; revision: number }, key = sendKey()) => mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: key });

  it("answers 404 for a draft id that is malformed or belongs to no draft of the organization", async () => {
    const f = await fixture();
    expect(await refusal(mgmt.approveAndSendDraft(f.replyDeps, f.actor, "not-a-uuid", { revision: 1, idempotencyKey: sendKey() }))).toEqual({ status: 404, error: "Draft not found" });
    expect(await refusal(mgmt.approveAndSendDraft(f.replyDeps, f.actor, RANDOM_ID, { revision: 1, idempotencyKey: sendKey() }))).toEqual({ status: 404, error: "Draft not found" });
  });

  it("answers 422 for an idempotency key shorter than 8 characters once trimmed", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    // Long enough for the route's zod check, short after the use case trims it.
    expect(await refusal(approve(f, draft, "   short   "))).toEqual({ status: 422, error: "An idempotency key of 8 to 200 characters is required.", issues: [] });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a key another draft already used", async () => {
    const f = await fixture();
    const a = await withDraft(f);
    const b = await withDraft(f);
    const key = sendKey();
    expect(await approve(f, a.draft, key)).toMatchObject({ status: "sent" });
    expect(await refusal(approve(f, b.draft, key))).toEqual({ status: 409, error: "This idempotency key belongs to another draft." });
    expect(await count("send_attempts", f.org)).toBe(1);
  });

  it("answers 409 for a draft that is no longer awaiting review", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    await mgmt.discardDraft(f.replyDeps, f.actor, draft.id);
    expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "This draft is discarded and cannot be sent." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a revision other than the current one", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    expect(await refusal(approve(f, { id: draft.id, revision: draft.revision + 1 }))).toEqual({ status: 409, error: "The draft changed since you reviewed it. Reload and approve the current text." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a draft on a conversation that is not email", async () => {
    const f = await fixture();
    // A LinkedIn draft on the same record, approved through the email path. A conversation's channel cannot change.
    const first = await withDraft(f);
    const [chat] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id)
      values (${f.org}, ${first.recordId}, 'linkedin', ${RANDOM_ID}, ${"chat-" + f.tag}) returning id`;
    const [linkedin] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, ai_body_text, status)
      select ${f.org}, id, ${chat.id}, context_version, 'linkedin', 'Tuesday works.', 'awaiting_review' from records where id = ${first.recordId}
      returning id, revision`;
    expect(await refusal(approve(f, { id: linkedin.id, revision: linkedin.revision }))).toEqual({ status: 409, error: "This is not an email conversation." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 and marks the draft stale when the record moved on after the draft was written", async () => {
    const f = await fixture();
    const { draft, recordId } = await withDraft(f);
    // A write that bumps the version without retiring the draft, so the send's own version check catches it.
    await sql`update records set context_version = context_version + 1 where id = ${recordId}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "A newer message arrived after this draft was written. Review the thread and regenerate the draft." });
    expect(await one("select status, error from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale", error: "A newer message arrived after this draft was written." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a closed conversation", async () => {
    const f = await fixture();
    const { r, draft } = await withDraft(f);
    await sql`update conversations set status = 'closed' where id = ${r.conversationId}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "This conversation is closed." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a person with no email address", async () => {
    const f = await fixture();
    const { r, draft } = await withDraft(f);
    await sql`update people set email = null where id = ${r.personId}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "This person has no email address." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 422 for a draft whose text is blank, as LinkedIn does", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    await sql`update drafts set ai_body_text = '  ', edited_body_text = null where id = ${draft.id}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 422, error: "The reply cannot be empty.", issues: [] });
    // An edit to blank text counts too: the edited text wins over the AI text even when it is empty.
    await sql`update drafts set ai_body_text = 'Sure, Tuesday works.', edited_body_text = ' ' where id = ${draft.id}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 422, error: "The reply cannot be empty.", issues: [] });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 with the reason a stale draft went stale", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    await sql`update drafts set status = 'stale', error = 'A person changed the reply type after this draft was written.' where id = ${draft.id}`;
    expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "A person changed the reply type after this draft was written. Review the thread and regenerate the draft." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  describe("after a person closes reply handling", () => {
    const CLOSED = { status: 409, error: "Reply handling is marked done. Reopen it to reply." };

    it("answers 409 for the draft the close retired, and names the close once reply handling reopens", async () => {
      const f = await fixture();
      const { draft, recordId } = await withDraft(f);
      await handling.closeRecord(handlingDeps, f.actor, recordId, { reason: "Went with a competitor" });
      expect(await one("select status, error from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale", error: "A person closed reply handling after this draft was written." });
      expect(await refusal(approve(f, draft))).toEqual(CLOSED);
      await handling.reopenRecord(handlingDeps, f.actor, recordId);
      expect(await refusal(approve(f, draft))).toEqual({ status: 409, error: "A person closed reply handling after this draft was written. Review the thread and regenerate the draft." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("refuses a typed reply and the send of a draft written after the close, says so on the panel, and the record stays closed", async () => {
      const f = await fixture();
      const { r, recordId } = await withDraft(f);
      await handling.closeRecord(handlingDeps, f.actor, recordId, { reason: "Went with a competitor" });
      expect(await refusal(mgmt.createManualDraft(f.replyDeps, f.actor, r.conversationId, { subject: "Re: hello", bodyText: "One last note." }))).toEqual(CLOSED);
      // A draft for the current version that no close retired, as an AI job that read its context after the close writes.
      const [late] = await sql`
        insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject, edited_body_text, status, provider)
        select organization_id, id, ${r.conversationId}, context_version, 'email', 'Re: hello', 'One last note.', 'awaiting_review', 'manual' from records where id = ${recordId}
        returning id, revision`;
      const before = mailbox.delivered.length;
      expect(await refusal(approve(f, { id: late.id, revision: late.revision }))).toEqual(CLOSED);
      expect(mailbox.delivered.length).toBe(before);
      expect(await count("send_attempts", f.org)).toBe(0);
      expect(await one("select workflow_state, closed_reason from records where id = $1", [recordId])).toMatchObject({ workflow_state: "closed", closed_reason: "Went with a competitor" });
      // The panel turns Approve and send off with the same sentence.
      expect((await panel(f, r.conversationId)).mailboxIssue).toBe(CLOSED.error);
    });
  });
});

describeDb("LinkedIn reply send refusals", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let app: typeof import("../../application/linkedin-reply");
  let store: typeof import("../drizzle-linkedin-reply-store").drizzleLinkedInReplyStore;
  let makeSender: typeof import("../linkedin-reply-sender").createLinkedInReplySender;
  let Fake: typeof import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway").FakeLinkedInGateway;
  let handling: typeof import("../../application/reply-handling");
  let handlingDeps: import("../../application/reply-handling").ReplyHandlingDeps;
  const orgs: TestOrg[] = [];

  /** An organization with a connected LinkedIn account and one inbound chat message. The gap between replies is off. */
  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "LI refusals");
    orgs.push(created);
    const { organizationId: org, userId: user } = created;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-" + tag}, 'Jo Owner', 'connected') returning id`;
    await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql.json({ replyGapSeconds: 0 })})`;
    const fake = new Fake();
    const input: InboundLinkedInInput = {
      organizationId: org,
      accountRef: account,
      accountName: "Jo Owner",
      providerThreadId: `chat-${tag}`,
      providerMessageId: `msg-${tag}`,
      counterparty: { providerId: `ACo-lead-${tag}`, name: "Ada Lovelace", profileUrl: `https://www.linkedin.com/in/ada-${tag}`, slug: `ada-${tag}` },
      personId: null,
      bodyText: "Sounds good, tell me more",
      receivedAt: new Date(),
    };
    const ingested = await composition.ingestInboundLinkedInMessage(input);
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    const deps: LinkedInReplyDeps = { store, sender: makeSender(fake), now: () => new Date() };
    const [{ record_id: recordId }] = await sql`select record_id from conversations where id = ${ingested.conversationId}`;
    return { org, tag, account: account as string, actor, fake, deps, conversationId: ingested.conversationId, recordId: recordId as string };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const key = () => `key-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const one = async (query: string, params: unknown[]) => (await sql.unsafe(query, params as never[]))[0];
  const count = async (table: string, org: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1 and ${where}`, [org]))[0].n);
  const send = (f: Fx, input: { text?: string; idempotencyKey?: string; draftId?: string; revision?: number } = {}, conversationId = f.conversationId) =>
    app.sendLinkedInReply(f.deps, f.actor, conversationId, { text: "Happy to share more.", idempotencyKey: key(), ...input });

  /** A second conversation on the fixture's record. A conversation's channel, account and chat cannot change once written. */
  async function conversationOn(f: Fx, input: { channel?: string; accountRef: string; chat: string | null }) {
    const [row] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id)
      values (${f.org}, ${f.recordId}, ${input.channel ?? "linkedin"}, ${input.accountRef}, ${input.chat}) returning id`;
    return row.id as string;
  }

  /** A LinkedIn draft awaiting review, written against the record's current version. */
  async function draftFor(f: Fx, status = "awaiting_review", error: string | null = null) {
    const [d] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, ai_body_text, status, error)
      select ${f.org}, r.id, ${f.conversationId}, r.context_version, 'linkedin', 'Tuesday works for me.', ${status}, ${error} from records r where r.id = ${f.recordId}
      returning id, revision`;
    return { draftId: d.id as string, revision: d.revision as number };
  }

  beforeAll(async () => {
    composition = await import("../composition");
    app = await import("../../application/linkedin-reply");
    store = (await import("../drizzle-linkedin-reply-store")).drizzleLinkedInReplyStore;
    makeSender = (await import("../linkedin-reply-sender")).createLinkedInReplySender;
    Fake = (await import("@/contexts/outreach/linkedin/infrastructure/fake-linkedin-gateway")).FakeLinkedInGateway;
    handling = await import("../../application/reply-handling");
    handlingDeps = (await import("../reply-handling-composition")).replyHandlingDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("answers 404 for a conversation id that is malformed or belongs to no conversation of the organization", async () => {
    const f = await fixture();
    expect(await refusal(send(f, {}, "not-a-uuid"))).toEqual({ status: 404, error: "Conversation not found" });
    expect(await refusal(send(f, {}, RANDOM_ID))).toEqual({ status: 404, error: "Conversation not found" });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 422 for an idempotency key shorter than 8 characters once trimmed", async () => {
    const f = await fixture();
    // Long enough for the route's zod check, short after the use case trims it.
    expect(await refusal(send(f, { idempotencyKey: "   short   " }))).toEqual({ status: 422, error: "An idempotency key of 8 to 200 characters is required.", issues: [] });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a key another conversation already used", async () => {
    const a = await fixture();
    const b = await fixture();
    const k = key();
    expect(await send(a, { idempotencyKey: k })).toMatchObject({ status: "sent" });
    // Organization B's own chat, with A's key: the key lookup is global.
    expect(await refusal(send(b, { idempotencyKey: k }))).toEqual({ status: 409, error: "This idempotency key belongs to another conversation." });
    expect(await count("send_attempts", b.org)).toBe(0);
  });

  it("answers 409 for a conversation on another channel", async () => {
    const f = await fixture();
    const email = await conversationOn(f, { channel: "email", accountRef: "me@corp.test", chat: `thread-${f.tag}` });
    expect(await refusal(send(f, {}, email))).toEqual({ status: 409, error: "This is not a LinkedIn conversation." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a closed conversation", async () => {
    const f = await fixture();
    await sql`update conversations set status = 'closed' where id = ${f.conversationId}`;
    expect(await refusal(send(f))).toEqual({ status: 409, error: "This conversation is closed." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 for a conversation with no LinkedIn chat yet", async () => {
    const f = await fixture();
    const noChat = await conversationOn(f, { accountRef: f.account, chat: null });
    expect(await refusal(send(f, {}, noChat))).toEqual({ status: 409, error: "There is no LinkedIn chat for this conversation yet." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("answers 409 when the conversation's account ref is not an account id, or names no account of the organization", async () => {
    const f = await fixture();
    const notAnId = await conversationOn(f, { accountRef: "jo@linkedin", chat: `chat-a-${f.tag}` });
    expect(await refusal(send(f, {}, notAnId))).toEqual({ status: 409, error: "No LinkedIn account is connected for this conversation." });
    const noAccount = await conversationOn(f, { accountRef: RANDOM_ID, chat: `chat-b-${f.tag}` });
    expect(await refusal(send(f, {}, noAccount))).toEqual({ status: 409, error: "No LinkedIn account is connected for this conversation." });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  describe("with a draft", () => {
    it("answers 404 for a draft id that is malformed or not a LinkedIn draft of this conversation, and 422 for revision 0", async () => {
      const f = await fixture();
      expect(await refusal(send(f, { draftId: "not-a-uuid", revision: 1 }))).toEqual({ status: 404, error: "Draft not found" });
      expect(await refusal(send(f, { draftId: RANDOM_ID, revision: 1 }))).toEqual({ status: 404, error: "Draft not found" });
      const draft = await draftFor(f);
      // A draftId without a revision never reaches the use case: the route's zod refine answers 400 first.
      expect(await refusal(send(f, { draftId: draft.draftId, revision: 0 }))).toEqual({ status: 422, error: "The draft revision is missing. Reload and try again.", issues: [] });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("answers 409 with the reason a stale draft went stale, and the status text for any other settled draft", async () => {
      const f = await fixture();
      const stale = await draftFor(f, "stale", "A newer message arrived after this draft was written.");
      expect(await refusal(send(f, stale))).toEqual({ status: 409, error: "A newer message arrived after this draft was written. Review the thread and regenerate the draft." });
      await sql`update drafts set error = null where id = ${stale.draftId}`;
      expect(await refusal(send(f, stale))).toEqual({ status: 409, error: "This draft is out of date. Review the thread and regenerate the draft." });
      const discarded = await draftFor(f, "discarded");
      expect(await refusal(send(f, discarded))).toEqual({ status: 409, error: "This draft is discarded and cannot be sent." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("answers 409 with the draft's own status when the draft being sent is the one in flight", async () => {
      const f = await fixture();
      const sending = await draftFor(f, "sending");
      expect(await refusal(send(f, sending))).toEqual({ status: 409, error: "This draft is sending and cannot be sent." });
      await sql`update drafts set status = 'delivery_uncertain' where id = ${sending.draftId}`;
      expect(await refusal(send(f, { ...sending, draftId: sending.draftId.toUpperCase() }))).toEqual({ status: 409, error: "This draft is delivery uncertain and cannot be sent." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("answers 409 for a revision other than the current one", async () => {
      const f = await fixture();
      const draft = await draftFor(f);
      expect(await refusal(send(f, { draftId: draft.draftId, revision: draft.revision + 1 }))).toEqual({ status: 409, error: "The draft changed since you reviewed it. Reload and approve the current text." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("answers 409 and marks the draft stale when the record moved on after the draft was written", async () => {
      const f = await fixture();
      const draft = await draftFor(f);
      await sql`update records set context_version = context_version + 1 where id = ${f.recordId}`;
      expect(await refusal(send(f, draft))).toEqual({ status: 409, error: "A newer message arrived after this draft was written. Review the thread and regenerate the draft." });
      expect(await one("select status, error from drafts where id = $1", [draft.draftId])).toMatchObject({ status: "stale", error: "A newer message arrived after this draft was written." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });
  });

  it("answers 422 for blank text, as email does", async () => {
    const f = await fixture();
    expect(await refusal(send(f, { text: " \r\n " }))).toEqual({ status: 422, error: "The reply cannot be empty.", issues: [] });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  describe("after a person closes reply handling", () => {
    const CLOSED = { status: 409, error: "Reply handling is marked done. Reopen it to reply." };

    it("answers 409 for the draft the close retired, and names the close once reply handling reopens", async () => {
      const f = await fixture();
      const draft = await draftFor(f);
      await handling.closeRecord(handlingDeps, f.actor, f.recordId, { reason: "Not a fit" });
      expect(await one("select status, error from drafts where id = $1", [draft.draftId])).toMatchObject({ status: "stale", error: "A person closed reply handling after this draft was written." });
      expect(await refusal(send(f, draft))).toEqual(CLOSED);
      await handling.reopenRecord(handlingDeps, f.actor, f.recordId);
      expect(await refusal(send(f, draft))).toEqual({ status: 409, error: "A person closed reply handling after this draft was written. Review the thread and regenerate the draft." });
      expect(await count("send_attempts", f.org)).toBe(0);
    });

    it("refuses typed text with no draft, says so on the panel, and the record stays closed", async () => {
      const f = await fixture();
      await handling.closeRecord(handlingDeps, f.actor, f.recordId, { reason: "Not a fit" });
      expect(await refusal(send(f, { text: "One last note." }))).toEqual(CLOSED);
      expect(f.fake.messages).toEqual([]);
      expect(await count("send_attempts", f.org)).toBe(0);
      expect((await app.getLinkedInReplyPanel(f.deps, f.actor, f.conversationId))?.issue).toBe(CLOSED.error);
      expect(await one("select workflow_state, closed_reason from records where id = $1", [f.recordId])).toMatchObject({ workflow_state: "closed", closed_reason: "Not a fit" });
    });
  });
});
