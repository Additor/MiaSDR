import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { conversations, draftKnowledgeCitations, drafts, events, messages, people, records, sendAttempts, replyTypes } from "@/platform/db/schema";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { NewDraft, PanelData, ReplyStore } from "../application/reply-ports";
import { checkNoneInFlight, checkRecordOpen, checkReplyText, checkThreadWritable, REPLY_REFUSALS } from "../domain/reply-send";
import { buildDraftContext, excerptHash } from "./thread-context";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { toDraftRow, toAttempt, mailboxFor, blockedAddressesFor, knownCcsFor, ccContextFor, draftCanBecome, draftIn } from "./reply-store-shared";
import { canMoveDraft, IN_FLIGHT_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES, type DraftStatus } from "../domain/draft-status";
import { isDoNotContact, isSuppressed } from "@/contexts/people/infrastructure/reachability";

type AiDraft = NewDraft & { feedback?: string | null };
type WrittenDraft = { id: string; stale: boolean };

/**
 * Writes an AI draft in `tx` (`ReplyStore.insertDraft`). `held` runs once the record is locked: the AI worker passes its
 * claim check there, so the record lock comes before the job row lock, and a false answer writes nothing and returns null.
 */
export async function insertDraftTx(tx: DbTx, input: AiDraft): Promise<WrittenDraft>;
export async function insertDraftTx(tx: DbTx, input: AiDraft, held: (tx: DbTx) => Promise<boolean>): Promise<WrittenDraft | null>;
export async function insertDraftTx(tx: DbTx, input: AiDraft, held?: (tx: DbTx) => Promise<boolean>): Promise<WrittenDraft | null> {
  // A writer that read its context before the version moved (an undo, a type change, a new reply) wrote for a context
  // that no longer holds. Its draft goes in as stale and leaves the record's open drafts alone.
  const [record] = await tx
    .select({ version: records.contextVersion })
    .from(records)
    .where(and(eq(records.id, input.recordId), eq(records.organizationId, input.organizationId)))
    .for("update");
  if (!record) throw new NotFoundError("Reply handling not found");
  if (held && !(await held(tx))) return null;
  if (record.version !== input.expectedContextVersion) {
    const [stale] = await tx
        .insert(drafts)
        .values({
          organizationId: input.organizationId,
          recordId: input.recordId,
          conversationId: input.conversationId,
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
        })
        .returning({ id: drafts.id });
    return { id: stale.id, stale: true };
  }
  const [created] = await tx
    .insert(drafts)
    .values({
      organizationId: input.organizationId,
      recordId: input.recordId,
      conversationId: input.conversationId,
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
    })
    .returning({ id: drafts.id });
  if (input.regeneratesDraftId) {
    await tx
      .update(drafts)
      .set({ status: "discarded" })
      .where(and(eq(drafts.id, input.regeneratesDraftId), eq(drafts.organizationId, input.organizationId), draftCanBecome("discarded")));
  }
  // One reviewable draft per record and channel: older open ones are superseded.
  await tx
    .update(drafts)
    .set({ status: "stale" })
    .where(and(eq(drafts.recordId, input.recordId), eq(drafts.channel, input.channel ?? "email"), draftIn(UNSENT_DRAFT_STATUSES), sql`${drafts.id} <> ${created.id}`));
  if (input.citations.length > 0) {
    await tx
      .insert(draftKnowledgeCitations)
      .values(input.citations.map((c, rank) => ({ organizationId: input.organizationId, draftId: created.id, documentVersionId: c.documentVersionId, excerptHash: excerptHash(c.excerpt), excerpt: c.excerpt, rank: String(rank) })))
      .onConflictDoNothing();
  }
  return { id: created.id, stale: false };
}

/** The reply panel and the draft lifecycle: load, write, edit, discard, and the CC and blocked-address checks. */
export const replyDraftMethods: Pick<ReplyStore, "panel" | "draftContext" | "draftContextForDraft" | "insertDraft" | "getDraft" | "ccContext" | "ccContextForConversation" | "createManualDraft" | "blockedAddresses" | "updateDraft" | "discardDraft"> = {
  async panel(organizationId, conversationId) {
    const [head] = await db
      .select({
        conversationId: conversations.id,
        channel: conversations.channel,
        accountRef: conversations.accountRef,
        status: conversations.status,
        recordId: records.id,
        replyTypeSetId: records.replyTypeSetId,
        state: records.workflowState,
        version: records.contextVersion,
        lastIn: records.lastInboundAt,
        lastOut: records.lastOutboundAt,
        personId: people.id,
        email: people.email,
      })
      .from(conversations)
      .innerJoin(records, eq(records.id, conversations.recordId))
      .innerJoin(people, eq(people.id, records.personId))
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId), publicConversation));
    if (!head) return null;

    const taxonomyRows = await db
      .select({ id: replyTypes.id, key: replyTypes.key, name: replyTypes.name, groupKey: replyTypes.groupKey })
      .from(replyTypes)
      .where(and(eq(replyTypes.replyTypeSetId, head.replyTypeSetId), eq(replyTypes.active, true)))
      .orderBy(replyTypes.sortOrder);

    const [draftRow] = await db
      .select()
      .from(drafts)
      // A stale draft stays visible, flagged out of date, until a person regenerates or discards it or a newer draft replaces it.
      .where(and(eq(drafts.conversationId, conversationId), sql`${drafts.status} <> 'discarded'`))
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    let draft: PanelData["draft"] = null;
    if (draftRow) {
      const [attempt] = await db.select().from(sendAttempts).where(eq(sendAttempts.draftId, draftRow.id)).orderBy(desc(sendAttempts.createdAt)).limit(1);
      draft = { ...toDraftRow(draftRow), attempt: attempt ? toAttempt(attempt) : null };
    }

    const suppressed = await isSuppressed(db, organizationId, head.email);
    const dnc = await isDoNotContact(db, organizationId, head.personId);
    const mailbox = await mailboxFor(organizationId, head.accountRef);

    const [newest] = await db
      .select({ subject: messages.subject })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), sql`${messages.subject} is not null`))
      .orderBy(desc(messages.sentAt))
      .limit(1);

    return {
      conversationId: head.conversationId,
      recordId: head.recordId,
      channel: head.channel,
      workflowState: head.state,
      contextVersion: head.version,
      recipient: head.email,
      lastSubject: newest?.subject ?? null,
      draft,
      taxonomy: taxonomyRows.map(({ key, name, groupKey }) => ({ key, name, groupKey })),
      suppressed,
      doNotContact: dnc,
      mailboxIssue: !mailbox
        ? "No mailbox is connected for this thread."
        : mailbox.status !== "connected"
          ? `The mailbox ${mailbox.emailAddress} is ${mailbox.status}.`
          : head.state === "closed"
            ? REPLY_REFUSALS.handling_closed.text()
            : head.status !== "active"
              ? REPLY_REFUSALS.conversation_closed.text()
              : null,
      answered: Boolean(head.lastOut && head.lastIn && head.lastOut >= head.lastIn),
      knownCcs: await knownCcsFor(organizationId, head.personId),
    };
  },

  draftContext: (organizationId, conversationId) => buildDraftContext(organizationId, conversationId),

  async draftContextForDraft(organizationId, draftId) {
    const draft = await this.getDraft(organizationId, draftId);
    if (!draft) return null;
    const ctx = await buildDraftContext(organizationId, draft.conversationId);
    return ctx ? { ...ctx, draft } : null;
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
      .select({ conversationId: drafts.conversationId })
      .from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId)));
    return row ? ccContextFor(organizationId, row.conversationId) : null;
  },

  ccContextForConversation: (organizationId, conversationId) => ccContextFor(organizationId, conversationId),

  async createManualDraft(input) {
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({
          recordId: records.id,
          personId: records.personId,
          version: records.contextVersion,
          latest: records.latestInboundMessageId,
          workflowState: records.workflowState,
          email: people.email,
          channel: conversations.channel,
          status: conversations.status,
        })
        .from(conversations)
        .innerJoin(records, eq(records.id, conversations.recordId))
        .innerJoin(people, eq(people.id, records.personId))
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId), publicConversation))
        // Serializes typed drafts with each other and with AI draft writes, which lock the record too.
        .for("update", { of: records });
      if (!head) throw new NotFoundError("Conversation not found");
      // A typed draft is not a send, but one written where a send is refused could never go out (docs/decisions.md,
      // "Reply send rules").
      checkRecordOpen(head, "email");
      checkThreadWritable(head, "email");

      if (await isSuppressed(tx, input.organizationId, head.email)) throw new ConflictError("This address is on the suppression list. A reply cannot be written.");
      if (await isDoNotContact(tx, input.organizationId, head.personId)) throw new ConflictError("This person is marked do not contact. A reply cannot be written.");

      // The send rule's unit: the conversation. A reply in flight on another conversation of the record leaves this one free.
      const [inFlight] = await tx
        .select({ id: drafts.id, status: drafts.status })
        .from(drafts)
        .where(and(eq(drafts.conversationId, input.conversationId), draftIn(IN_FLIGHT_DRAFT_STATUSES)))
        .limit(1);
      checkNoneInFlight(inFlight, null, "email");

      const [created] = await tx
        .insert(drafts)
        .values({
          organizationId: input.organizationId,
          recordId: head.recordId,
          conversationId: input.conversationId,
          replyForMessageId: head.latest,
          expectedContextVersion: head.version,
          channel: "email",
          subject: input.subject,
          aiBodyText: null,
          editedBodyText: input.bodyText,
          cc: input.cc,
          status: "awaiting_review",
          provider: "manual",
          request: { source: "manual", createdBy: input.actorUserId, contextVersion: head.version },
        })
        .returning({ id: drafts.id, revision: drafts.revision });
      // One reviewable draft per record: older open ones are superseded.
      await tx
        .update(drafts)
        .set({ status: "stale" })
        .where(and(eq(drafts.recordId, head.recordId), eq(drafts.channel, "email"), draftIn(UNSENT_DRAFT_STATUSES), sql`${drafts.id} <> ${created.id}`));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        recordId: head.recordId,
        eventType: "draft.created_manual",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { draftId: created.id, conversationId: input.conversationId },
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
      // A LinkedIn message has no subject and no CC, and the platform caps its length.
      const linkedin = row.channel === "linkedin";
      if (linkedin) checkReplyText(input.bodyText, "linkedin");
      const [updated] = await tx
        .update(drafts)
        .set({ editedBodyText: input.bodyText, subject: linkedin ? null : (input.subject ?? row.subject), ...(input.cc && !linkedin ? { cc: input.cc } : {}), revision: row.revision + 1, error: null })
        .where(eq(drafts.id, draftId))
        .returning();
      return toDraftRow(updated);
    });
  },

  async discardDraft(organizationId, draftId, actorUserId) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: drafts.id, status: drafts.status, recordId: drafts.recordId, personId: records.personId })
        .from(drafts)
        .innerJoin(records, eq(records.id, drafts.recordId))
        .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId)))
        .for("update", { of: drafts });
      if (!row) throw new NotFoundError("Draft not found");
      if (!canMoveDraft(row.status as DraftStatus, "discarded")) {
        throw new ConflictError(`A draft that is ${row.status.replace(/_/g, " ")} cannot be discarded.`);
      }
      await tx.update(drafts).set({ status: "discarded" }).where(and(eq(drafts.id, draftId), draftCanBecome("discarded")));
      await tx.insert(events).values({ organizationId, personId: row.personId, recordId: row.recordId, eventType: "draft.discarded", actorType: "human", actorUserId, meta: { draftId } });
    });
  },
};
