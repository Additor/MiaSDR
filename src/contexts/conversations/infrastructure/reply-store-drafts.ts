import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { classifications, contactPolicies, conversations, draftKnowledgeCitations, drafts, events, messages, people, records, sendAttempts, subcategories, suppressionList } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { PanelData, ReplyStore } from "../application/reply-ports";
import { MAX_LINKEDIN_REPLY } from "../domain/linkedin-reply";
import type { HoldReason } from "../domain/classification-policy";
import { buildDraftContext, excerptHash } from "./thread-context";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { toDraftRow, toAttempt, mailboxFor, blockedAddressesFor, knownCcsFor, ccContextFor, draftCanBecome, draftIn } from "./reply-store-shared";
import { canMoveDraft, UNSENT_DRAFT_STATUSES, type DraftStatus } from "../domain/draft-status";

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
        pipelineId: records.pipelineId,
        state: records.workflowState,
        version: records.contextVersion,
        latest: records.latestInboundMessageId,
        categoryKey: records.categoryKey,
        subcategoryId: records.subcategoryId,
        categorySource: records.categorySource,
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
      .select({ id: subcategories.id, key: subcategories.key, name: subcategories.name, categoryKey: subcategories.categoryKey })
      .from(subcategories)
      .where(and(eq(subcategories.pipelineId, head.pipelineId), eq(subcategories.active, true)))
      .orderBy(subcategories.sortOrder);
    const nameOf = (id: string | null) => taxonomyRows.find((t) => t.id === id);
    const current = nameOf(head.subcategoryId);

    let classification: PanelData["classification"] = null;
    if (head.latest) {
      const [c] = await db
        .select()
        .from(classifications)
        .where(and(eq(classifications.recordId, head.recordId), eq(classifications.messageId, head.latest)))
        .orderBy(sql`(${classifications.status} = 'stale')`, desc(classifications.createdAt))
        .limit(1);
      if (c) {
        const proposed = nameOf(c.proposedSubcategoryId);
        const response = (c.response ?? {}) as { holdReason?: HoldReason | null; stopRequested?: boolean };
        classification = {
          id: c.id,
          status: c.status,
          proposed: proposed ? { subcategoryKey: proposed.key, name: proposed.name, categoryKey: proposed.categoryKey } : null,
          confidence: c.confidence === null ? null : Number(c.confidence),
          reasoning: c.reasoning,
          holdReason: response.holdReason ?? null,
          stopRequested: response.stopRequested === true,
          error: c.error,
          current: c.expectedContextVersion === head.version && c.status !== "stale",
          acknowledged: c.acknowledgedAt !== null,
        };
      }
    }

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

    const email = head.email?.toLowerCase() ?? null;
    const [suppressed] = email
      ? await db.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.email, email)))
      : [];
    const [dnc] = await db.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, head.personId));
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
      category: head.categoryKey && head.categorySource ? { categoryKey: head.categoryKey, subcategoryKey: current?.key ?? null, name: current?.name ?? head.categoryKey, source: head.categorySource } : null,
      classification,
      draft,
      taxonomy: taxonomyRows.map(({ key, name, categoryKey }) => ({ key, name, categoryKey })),
      suppressed: Boolean(suppressed),
      doNotContact: dnc?.d === true,
      mailboxIssue: !mailbox ? "No mailbox is connected for this thread." : mailbox.status !== "connected" ? `The mailbox ${mailbox.emailAddress} is ${mailbox.status}.` : head.status !== "active" ? "This conversation is closed." : null,
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
    return db.transaction(async (tx) => {
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
      return created;
    });
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
          email: people.email,
          channel: conversations.channel,
          status: conversations.status,
        })
        .from(conversations)
        .innerJoin(records, eq(records.id, conversations.recordId))
        .innerJoin(people, eq(people.id, records.personId))
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId), publicConversation))
        // Serializes concurrent creates and sends for the record.
        .for("update", { of: records });
      if (!head) throw new NotFoundError("Conversation not found");
      if (head.channel !== "email") throw new ConflictError("Typed replies are only available on email conversations.");
      if (head.status !== "active") throw new ConflictError("This conversation is closed.");
      if (!head.email) throw new ConflictError("This person has no email address.");

      const [suppressed] = await tx
        .select({ id: suppressionList.id })
        .from(suppressionList)
        .where(and(eq(suppressionList.organizationId, input.organizationId), eq(suppressionList.email, head.email.toLowerCase())));
      if (suppressed) throw new ConflictError("This address is on the suppression list. A reply cannot be written.");
      const [dnc] = await tx.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, head.personId));
      if (dnc?.d) throw new ConflictError("This person is marked do not contact. A reply cannot be written.");

      const inFlight = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.recordId, head.recordId), inArray(drafts.status, ["sending", "delivery_uncertain"])))
        .limit(1);
      if (inFlight.length > 0) throw new ConflictError("A reply is being sent for this thread.");

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
      if (linkedin && input.bodyText.length > MAX_LINKEDIN_REPLY) throw new ValidationError(`The reply is longer than ${MAX_LINKEDIN_REPLY} characters.`);
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
