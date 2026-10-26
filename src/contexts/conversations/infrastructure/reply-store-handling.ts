import { and, eq, sql } from "drizzle-orm";
import { createSuppressionStore } from "@/contexts/outreach/infrastructure/suppression-store";
import { followUpStop } from "../after-reply/infrastructure/sequence-stop";
import { db } from "@/platform/db/client";
import { restartRecordWorkTx } from "./restart-record-work";
import { aiJobs, classifications, conversations, drafts, events, people, records, subcategories } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { ReplyStore } from "../application/reply-ports";
import { afterManualCategory } from "../domain/workflow-state";
import { publicConversation } from "@/platform/db/conversation-visibility";

/** What a person decides about a reply: a classification of their own, or suppressing the sender. */
export const replyHandlingMethods: Pick<ReplyStore, "applyHumanClassification" | "suppressSender"> = {
  async applyHumanClassification(input) {
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({
          recordId: records.id,
          personId: records.personId,
          pipelineId: records.pipelineId,
          version: records.contextVersion,
          latest: records.latestInboundMessageId,
          categoryKey: records.categoryKey,
          subcategoryId: records.subcategoryId,
          state: records.workflowState,
        })
        .from(conversations)
        .innerJoin(records, eq(records.id, conversations.recordId))
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId), publicConversation))
        .for("update", { of: records });
      if (!head) throw new NotFoundError("Conversation not found");
      if (!head.latest) throw new ConflictError("There is no inbound message to classify.");
      if (head.version !== input.expectedContextVersion) throw new ConflictError("Reply handling changed after you opened it. Reload and choose the category again.");

      const [existing] = await tx
        .select()
        .from(classifications)
        .where(and(eq(classifications.messageId, head.latest), eq(classifications.expectedContextVersion, head.version)));

      let targetId: string | null;
      if (input.subcategoryKey === null) {
        if (!existing || existing.status !== "proposed" || !existing.proposedSubcategoryId) throw new ConflictError("There is no AI proposal to accept.");
        targetId = existing.proposedSubcategoryId;
      } else {
        const [found] = await tx
          .select({ id: subcategories.id })
          .from(subcategories)
          .where(and(eq(subcategories.pipelineId, head.pipelineId), eq(subcategories.key, input.subcategoryKey), eq(subcategories.active, true)));
        if (!found) throw new ValidationError("That subcategory is not active in your reply categories.");
        targetId = found.id;
      }
      const [target] = await tx.select().from(subcategories).where(eq(subcategories.id, targetId));
      const accepted = input.subcategoryKey === null;

      let classificationId: string;
      if (existing) {
        await tx
          .update(classifications)
          .set({ status: accepted ? "accepted" : "overridden", appliedCategoryKey: target.categoryKey, appliedSubcategoryId: target.id, acknowledgedAt: new Date() })
          .where(eq(classifications.id, existing.id));
        classificationId = existing.id;
      } else {
        const [row] = await tx
          .insert(classifications)
          .values({
            organizationId: input.organizationId,
            recordId: head.recordId,
            messageId: head.latest,
            expectedContextVersion: head.version,
            previousCategoryKey: head.categoryKey,
            previousSubcategoryId: head.subcategoryId,
            proposedCategoryKey: target.categoryKey,
            proposedSubcategoryId: target.id,
            appliedCategoryKey: target.categoryKey,
            appliedSubcategoryId: target.id,
            confidence: "1.0000",
            reasoning: "Set by a person.",
            status: "overridden",
            provider: "human",
            acknowledgedAt: new Date(),
          })
          .returning({ id: classifications.id });
        classificationId = row.id;
      }

      const wantsDraft = input.wantsDraft(target.categoryKey, target.key);
      const nextState = afterManualCategory(head.state, wantsDraft);
      await tx
        .update(records)
        .set({ categoryKey: target.categoryKey, subcategoryId: target.id, categorySource: "human", workflowState: nextState })
        .where(eq(records.id, head.recordId));
      // A correction replaces the reading every open draft and run was built on: they end, the version goes up, and the
      // sequence of the corrected subcategory starts. The classification row follows to the new version so the fresh draft job accepts it.
      const now = new Date();
      const restart = await restartRecordWorkTx(tx, {
        organizationId: input.organizationId,
        recordId: head.recordId,
        reason: "classification_corrected",
        draftReason: "A person corrected the category after this draft was written.",
        now,
        actorUserId: input.actorUserId,
      });
      await tx.update(classifications).set({ expectedContextVersion: restart.contextVersion }).where(eq(classifications.id, classificationId));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        recordId: head.recordId,
        eventType: accepted ? "classification.accepted" : "classification.overridden",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { categoryKey: head.categoryKey, subcategoryId: head.subcategoryId },
        toData: { categoryKey: target.categoryKey, subcategoryId: target.id },
        meta: { draftsRetired: restart.draftsRetired, runsEnded: restart.runsEnded, runStarted: restart.runStarted },
        contextVersion: restart.contextVersion,
      });
      let draftQueued = false;
      if (wantsDraft) {
        // One draft job exists per classification (unique on kind and entity). A job that already finished for an earlier
        // version goes back to the queue under a key for this version; a queued job stays and picks up the new version.
        const key = `initial_draft:classification:${classificationId}:v${restart.contextVersion}`;
        await tx
          .insert(aiJobs)
          .values({ organizationId: input.organizationId, kind: "initial_draft", entityType: "classification", entityId: classificationId, idempotencyKey: key, runAfter: sql`now() - interval '1 minute'`, payload: { humanInitiated: true } })
          .onConflictDoUpdate({
            target: [aiJobs.kind, aiJobs.entityType, aiJobs.entityId],
            set: { status: "queued", attempts: 0, runAfter: sql`now() - interval '1 minute'`, idempotencyKey: key, payload: sql`${aiJobs.payload} || '{"humanInitiated":true}'::jsonb`, completedAt: null, failedAt: null, lastError: null, lockedAt: null, lockedBy: null },
            setWhere: sql`${aiJobs.status} in ('succeeded', 'failed', 'skipped')`,
          });
        const [job] = await tx.select({ status: aiJobs.status }).from(aiJobs).where(and(eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityType, "classification"), eq(aiJobs.entityId, classificationId)));
        draftQueued = job?.status === "queued" || job?.status === "running";
      }
      return { personId: head.personId, categoryKey: target.categoryKey, subcategoryKey: target.key, draftQueued };
    });
  },

  async suppressSender(input) {
    const [head] = await db
      .select({ recordId: records.id, personId: records.personId, email: people.email })
      .from(conversations)
      .innerJoin(records, eq(records.id, conversations.recordId))
      .innerJoin(people, eq(people.id, records.personId))
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId), publicConversation));
    if (!head) throw new NotFoundError("Conversation not found");
    if (!head.email) throw new ConflictError("This person has no email address to suppress.");
    const email = head.email.toLowerCase();
    await createSuppressionStore(followUpStop).suppressEmail({ organizationId: input.organizationId, email, reason: "unsubscribed", note: "Asked to stop in a reply." });
    await db.transaction(async (tx) => {
      // A reply that is waiting for review would be refused at send time anyway; retire it now.
      await tx.update(drafts).set({ status: "stale", error: "The sender was suppressed." }).where(and(eq(drafts.recordId, head.recordId), eq(drafts.status, "awaiting_review")));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        recordId: head.recordId,
        eventType: "contact.suppressed",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { conversationId: input.conversationId },
      });
    });
    return { email };
  },
};
