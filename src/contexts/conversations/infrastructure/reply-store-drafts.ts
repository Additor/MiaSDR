import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { threads, drafts, events, mcpTokens, messages, people, conversations, sendAttempts, replyTypes } from "@/platform/db/schema";
import { ConflictError, NotFoundError, viaMeta } from "@/shared/errors";
import type { NewDraft, PanelData, ReplyStore } from "../application/reply-ports";
import { checkNoneInFlight, checkConversationOpen, checkReplyText, checkThreadWritable, HANDLING_CLOSED, REPLY_REFUSALS } from "../domain/reply-send";
import { buildDraftContext } from "./thread-context";
import { toAttempt } from "./reply-attempt-ledger";
import { toDraftRow, mailboxFor, blockedAddressesFor, knownCcsFor, ccContextFor, draftCanBecome, draftIn } from "./reply-store-shared";
import { canMoveDraft, IN_FLIGHT_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES, type DraftStatus } from "../domain/draft-status";
import { isDoNotContact, isSuppressed } from "@/contexts/people/infrastructure/reachability";

type AiDraft = NewDraft & { feedback?: string | null };
type WrittenDraft = { id: string; stale: boolean } | typeof HANDLING_CLOSED;

/**
 * Writes an AI draft in `tx` (`ReplyStore.insertDraft`). `held` runs once the conversation is locked: the AI worker passes its
 * claim check there, so the conversation lock comes before the job row lock, and a false answer writes nothing and returns null.
 * Reply handling marked done writes nothing and returns `HANDLING_CLOSED`, for every writer: a person's request, the
 * draft job and the sequence engine (docs/decisions.md, "Reply send rules").
 */
export async function insertDraftTx(tx: DbTx, input: AiDraft): Promise<WrittenDraft>;
export async function insertDraftTx(tx: DbTx, input: AiDraft, held: (tx: DbTx) => Promise<boolean>): Promise<WrittenDraft | null>;
export async function insertDraftTx(tx: DbTx, input: AiDraft, held?: (tx: DbTx) => Promise<boolean>): Promise<WrittenDraft | null> {
  // A writer that read its context before the version moved (an undo, a type change, a new reply) wrote for a context
  // that no longer holds. Its draft goes in as stale and leaves the conversation's open drafts alone.
  const [conversation] = await tx
    .select({ version: conversations.contextVersion, workflowState: conversations.workflowState })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId)))
    // No key update, so a reply send that holds the conversation and inserts its own draft passes (docs/database.md,
    // "Lock modes").
    .for("no key update");
  if (!conversation) throw new NotFoundError("Reply handling not found");
  if (held && !(await held(tx))) return null;
  if (conversation.workflowState === "closed") return HANDLING_CLOSED;
  if (conversation.version !== input.expectedContextVersion) {
    const [stale] = await tx
        .insert(drafts)
        .values({
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          threadId: input.threadId,
          replyForMessageId: input.replyForMessageId,
          expectedContextVersion: input.expectedContextVersion,
          channel: input.channel ?? "email",
          subject: input.channel === "linkedin" ? null : input.subject,
          aiBodyText: input.bodyText,
          status: "stale",
          error: "The reply handling changed while the AI wrote this draft.",
          provider: input.provider,
          model: input.model,
          request: { ...(input.request as object), regeneratedFrom: input.regeneratesDraftId, feedback: input.feedback ?? undefined },
          response: input.response,
          writtenViaTokenId: input.writtenViaTokenId ?? null,
        })
        .returning({ id: drafts.id });
    return { id: stale.id, stale: true };
  }
  const [created] = await tx
    .insert(drafts)
    .values({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      replyForMessageId: input.replyForMessageId,
      expectedContextVersion: input.expectedContextVersion,
      channel: input.channel ?? "email",
      subject: input.channel === "linkedin" ? null : input.subject,
      aiBodyText: input.bodyText,
      status: "awaiting_review",
      provider: input.provider,
      model: input.model,
      request: { ...(input.request as object), regeneratedFrom: input.regeneratesDraftId, feedback: input.feedback ?? undefined },
      response: input.response,
      writtenViaTokenId: input.writtenViaTokenId ?? null,
    })
    .returning({ id: drafts.id });
  if (input.regeneratesDraftId) {
    await tx
      .update(drafts)
      .set({ status: "discarded" })
      .where(and(eq(drafts.id, input.regeneratesDraftId), eq(drafts.organizationId, input.organizationId), draftCanBecome("discarded")));
  }
  // One reviewable draft per conversation and channel: older open ones are superseded.
  await tx
    .update(drafts)
    .set({ status: "stale" })
    .where(and(eq(drafts.conversationId, input.conversationId), eq(drafts.channel, input.channel ?? "email"), draftIn(UNSENT_DRAFT_STATUSES), sql`${drafts.id} <> ${created.id}`));
  return { id: created.id, stale: false };
}

/** The reply panel and the draft lifecycle: load, write, edit, discard, and the CC and blocked-address checks. */
export const replyDraftMethods: Pick<ReplyStore, "panel" | "draftContext" | "draftContextForDraft" | "insertDraft" | "getDraft" | "ccContext" | "ccContextForThread" | "createManualDraft" | "blockedAddresses" | "updateDraft" | "discardDraft"> = {
  async panel(organizationId, threadId) {
    const [head] = await db
      .select({
        threadId: threads.id,
        channel: threads.channel,
        accountRef: threads.accountRef,
        status: threads.status,
        conversationId: conversations.id,
        replyTypeSetId: conversations.replyTypeSetId,
        state: conversations.workflowState,
        version: conversations.contextVersion,
        lastIn: conversations.lastInboundAt,
        lastOut: conversations.lastOutboundAt,
        personId: people.id,
        email: people.email,
      })
      .from(threads)
      .innerJoin(conversations, eq(conversations.id, threads.conversationId))
      .innerJoin(people, eq(people.id, conversations.personId))
      .where(and(eq(threads.organizationId, organizationId), eq(threads.id, threadId)));
    if (!head) return null;

    const taxonomyRows = await db
      .select({ id: replyTypes.id, key: replyTypes.key, name: replyTypes.name, groupKey: replyTypes.groupKey })
      .from(replyTypes)
      .where(eq(replyTypes.replyTypeSetId, head.replyTypeSetId))
      .orderBy(replyTypes.sortOrder);

    const [draftRow] = await db
      .select()
      .from(drafts)
      // A stale draft stays visible, flagged out of date, until a person regenerates or discards it or a newer draft replaces it.
      .where(and(eq(drafts.threadId, threadId), sql`${drafts.status} <> 'discarded'`))
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    let draft: PanelData["draft"] = null;
    if (draftRow) {
      const [attempt] = await db.select().from(sendAttempts).where(eq(sendAttempts.draftId, draftRow.id)).orderBy(desc(sendAttempts.createdAt)).limit(1);
      const [token] = draftRow.writtenViaTokenId
        ? await db.select({ name: mcpTokens.name }).from(mcpTokens).where(and(eq(mcpTokens.id, draftRow.writtenViaTokenId), eq(mcpTokens.organizationId, organizationId)))
        : [];
      draft = { ...toDraftRow(draftRow), writtenVia: token?.name ?? null, attempt: attempt ? toAttempt(attempt) : null };
    }

    const suppressed = await isSuppressed(db, organizationId, head.email);
    const dnc = await isDoNotContact(db, organizationId, head.personId);
    const mailbox = await mailboxFor(organizationId, head.accountRef);
    // Why no reply can be written here at all, the sentence the send refuses with.
    const closed = head.state === "closed" ? REPLY_REFUSALS.handling_closed.text() : head.status !== "active" ? REPLY_REFUSALS.conversation_closed.text() : null;

    const [newest] = await db
      .select({ subject: messages.subject })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), sql`${messages.subject} is not null`))
      .orderBy(desc(messages.sentAt))
      .limit(1);

    return {
      threadId: head.threadId,
      conversationId: head.conversationId,
      channel: head.channel,
      workflowState: head.state,
      contextVersion: head.version,
      recipient: head.email,
      lastSubject: newest?.subject ?? null,
      draft,
      taxonomy: taxonomyRows.map(({ key, name, groupKey }) => ({ key, name, groupKey })),
      suppressed,
      doNotContact: dnc,
      mailboxIssue: !mailbox ? "No mailbox is connected for this thread." : mailbox.status !== "connected" ? `The mailbox ${mailbox.emailAddress} is ${mailbox.status}.` : closed,
      closed,
      answered: Boolean(head.lastOut && head.lastIn && head.lastOut >= head.lastIn),
      knownCcs: await knownCcsFor(organizationId, head.personId),
    };
  },

  draftContext: (organizationId, threadId) => buildDraftContext(organizationId, threadId),

  async draftContextForDraft(organizationId, draftId) {
    const draft = await this.getDraft(organizationId, draftId);
    if (!draft) return null;
    const ctx = await buildDraftContext(organizationId, draft.threadId);
    if (!ctx) return null;
    const [conversation] = await db.select({ workflowState: conversations.workflowState }).from(conversations).where(eq(conversations.id, ctx.conversationId));
    return { ...ctx, draft, workflowState: conversation.workflowState };
  },

  async insertDraft(input) {
    return db.transaction((tx) => insertDraftTx(tx, input));
  },

  async getDraft(organizationId, draftId) {
    const [row] = await db.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId)));
    return row ? toDraftRow(row) : null;
  },

  async ccContext(organizationId, draftId) {
    const [row] = await db
      .select({ threadId: drafts.threadId })
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId)));
    return row ? ccContextFor(organizationId, row.threadId) : null;
  },

  ccContextForThread: (organizationId, threadId) => ccContextFor(organizationId, threadId),

  async createManualDraft(input) {
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({
          conversationId: conversations.id,
          personId: conversations.personId,
          version: conversations.contextVersion,
          latest: conversations.latestInboundMessageId,
          workflowState: conversations.workflowState,
          email: people.email,
          channel: threads.channel,
          status: threads.status,
          chat: threads.providerThreadId,
          accountRef: threads.accountRef,
        })
        .from(threads)
        .innerJoin(conversations, eq(conversations.id, threads.conversationId))
        .innerJoin(people, eq(people.id, conversations.personId))
        .where(and(eq(threads.id, input.threadId), eq(threads.organizationId, input.organizationId)))
        // Serializes typed drafts with each other and with AI draft writes, which lock the conversation too.
        .for("no key update", { of: conversations });
      if (!head) throw new NotFoundError("Conversation not found");
      const { channel } = input;
      // A typed draft is not a send, but one written where a send is refused could never go out (docs/decisions.md,
      // "Reply send rules").
      checkConversationOpen(head, channel);
      checkThreadWritable(head, channel);

      if (channel === "email" && (await isSuppressed(tx, input.organizationId, head.email))) throw new ConflictError("This address is on the suppression list. A reply cannot be written.");
      if (await isDoNotContact(tx, input.organizationId, head.personId)) throw new ConflictError("This person is marked do not contact. A reply cannot be written.");

      // The send rule's unit: the conversation. A reply in flight on another conversation of the conversation leaves this one free.
      const [inFlight] = await tx
        .select({ id: drafts.id, status: drafts.status })
        .from(drafts)
        .where(and(eq(drafts.threadId, input.threadId), draftIn(IN_FLIGHT_DRAFT_STATUSES)))
        .limit(1);
      checkNoneInFlight(inFlight, null, channel);

      if (input.expectedOpenRevision !== undefined) {
        // An edit holds the draft row, so this waits for one in progress and reads its revision.
        const open = await tx
          .select({ id: drafts.id, threadId: drafts.threadId, revision: drafts.revision })
          .from(drafts)
          .where(and(eq(drafts.conversationId, head.conversationId), eq(drafts.channel, channel), eq(drafts.status, "awaiting_review")))
          .for("update");
        const expectedId = input.expectedOpenDraftId?.toLowerCase();
        const other = open.find((draft) => draft.revision !== input.expectedOpenRevision || (expectedId !== undefined && draft.id !== expectedId));
        // A conversation holds one open draft per channel, so the one that goes stale can sit on another conversation of the person.
        if (other) throw new ConflictError(`${other.threadId === input.threadId ? "This conversation" : `Conversation ${other.threadId} of this person`} has an open draft, ${other.id}, at revision ${other.revision}. Read it, then pass its draftId and revision to replace it, or use edit.`, { code: "draft_open" });
      }

      const [created] = await tx
        .insert(drafts)
        .values({
          organizationId: input.organizationId,
          conversationId: head.conversationId,
          threadId: input.threadId,
          replyForMessageId: head.latest,
          expectedContextVersion: head.version,
          channel,
          subject: input.subject,
          aiBodyText: null,
          editedBodyText: input.bodyText,
          cc: input.cc,
          status: "awaiting_review",
          provider: "manual",
          request: { source: "manual", createdBy: input.actorUserId, contextVersion: head.version },
          writtenViaTokenId: input.via?.tokenId ?? null,
        })
        .returning({ id: drafts.id, revision: drafts.revision });
      // One reviewable draft per conversation: older open ones are superseded.
      await tx
        .update(drafts)
        .set({ status: "stale" })
        .where(and(eq(drafts.conversationId, head.conversationId), eq(drafts.channel, channel), draftIn(UNSENT_DRAFT_STATUSES), sql`${drafts.id} <> ${created.id}`));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        conversationId: head.conversationId,
        eventType: "draft.created_manual",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { draftId: created.id, threadId: input.threadId, ...viaMeta(input.via) },
      });
      return created;
    });
  },

  blockedAddresses: (organizationId, emails) => blockedAddressesFor(organizationId, emails),

  async updateDraft(organizationId, draftId, input) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId))).for("update");
      if (!row) throw new NotFoundError("Draft not found");
      if (row.status !== "awaiting_review") throw new ConflictError(`A draft that is ${row.status.replace(/_/g, " ")} can no longer be edited.`);
      if (row.revision !== input.expectedRevision) throw new ConflictError("The draft changed since you opened it. Reload and review it again.");
      // A LinkedIn message has no subject and no CC. The text rule of the send, so an edit saves what the send would take:
      // trimmed, not empty, within the channel's limit.
      const linkedin = row.channel === "linkedin";
      const bodyText = checkReplyText(input.bodyText, linkedin ? "linkedin" : "email");
      const [updated] = await tx
        .update(drafts)
        .set({
          editedBodyText: bodyText,
          subject: linkedin ? null : (input.subject ?? row.subject),
          ...(input.cc && !linkedin ? { cc: input.cc } : {}),
          revision: row.revision + 1,
          error: null,
          writtenViaTokenId: input.writtenViaTokenId,
        })
        .where(eq(drafts.id, draftId))
        .returning();
      return toDraftRow(updated);
    });
  },

  async discardDraft(organizationId, draftId, actorUserId, expectedRevision, via) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: drafts.id, status: drafts.status, revision: drafts.revision, conversationId: drafts.conversationId, personId: conversations.personId })
        .from(drafts)
        .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
        .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId)))
        .for("update", { of: drafts });
      if (!row) throw new NotFoundError("Draft not found");
      if (!canMoveDraft(row.status as DraftStatus, "discarded")) {
        throw new ConflictError(`A draft that is ${row.status.replace(/_/g, " ")} cannot be discarded.`);
      }
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new ConflictError("The draft changed since you opened it. Reload and review it again.");
      await tx.update(drafts).set({ status: "discarded" }).where(and(eq(drafts.id, draftId), draftCanBecome("discarded")));
      await tx.insert(events).values({ organizationId, personId: row.personId, conversationId: row.conversationId, eventType: "draft.discarded", actorType: "human", actorUserId, meta: { draftId, ...viaMeta(via) } });
    });
  },
};
