import { and, eq } from "drizzle-orm";
import { createSuppressionStore } from "@/contexts/outreach/infrastructure/suppression-store";
import { followUpStop } from "../after-reply/infrastructure/sequence-stop";
import { db } from "@/platform/db/client";
import { personTypeDecisionTx, queuePickDraftTx, restartRecordWorkTx } from "./restart-record-work";
import { replyTypePicks, conversations, drafts, events, people, records, replyTypes } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { ReplyStore } from "../application/reply-ports";
import { afterTypeChange } from "../domain/workflow-state";
import { typeRulesOf } from "../domain/reply-type";
import { publicConversation } from "@/platform/db/conversation-visibility";

/** What a person decides about a reply: a classification of their own, or suppressing the sender. */
export const replyHandlingMethods: Pick<ReplyStore, "applyHumanReplyTypePick" | "suppressSender"> = {
  async applyHumanReplyTypePick(input) {
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({
          recordId: records.id,
          personId: records.personId,
          replyTypeSetId: records.replyTypeSetId,
          version: records.contextVersion,
          latest: records.latestInboundMessageId,
          groupKey: records.groupKey,
          replyTypeId: records.replyTypeId,
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
        .from(replyTypePicks)
        .where(and(eq(replyTypePicks.messageId, head.latest), eq(replyTypePicks.expectedContextVersion, head.version)));

      let targetId: string | null;
      if (input.replyTypeKey === null) {
        if (!existing || existing.status !== "proposed" || !existing.proposedReplyTypeId) throw new ConflictError("There is no AI proposal to accept.");
        targetId = existing.proposedReplyTypeId;
      } else {
        const [found] = await tx
          .select({ id: replyTypes.id })
          .from(replyTypes)
          .where(and(eq(replyTypes.replyTypeSetId, head.replyTypeSetId), eq(replyTypes.key, input.replyTypeKey), eq(replyTypes.active, true)));
        if (!found) throw new ValidationError("That reply type is not active.");
        targetId = found.id;
      }
      const [target] = await tx.select().from(replyTypes).where(eq(replyTypes.id, targetId));
      const accepted = input.replyTypeKey === null;
      // Accepting a stop request would only change the type, while the person asked us to stop. The client opens Stop
      // contacting on this code. Choosing the stop request type by name stays allowed and changes only the type.
      if (accepted && target.systemRole === "stop_request") {
        throw new ConflictError("This reply asks to stop. Review the stop request: choose Stop contacting, or change the type.", { code: "stop_review" });
      }
      const rules = typeRulesOf(target);
      const decision = await personTypeDecisionTx(tx, input.organizationId, head.recordId, { groupKey: target.groupKey, rules });
      if (!decision) throw new NotFoundError("Conversation not found");

      let replyTypePickId: string;
      if (existing) {
        await tx
          .update(replyTypePicks)
          .set({ status: accepted ? "accepted" : "overridden", appliedGroupKey: target.groupKey, appliedReplyTypeId: target.id, rules, acknowledgedAt: new Date() })
          .where(eq(replyTypePicks.id, existing.id));
        replyTypePickId = existing.id;
      } else {
        const [row] = await tx
          .insert(replyTypePicks)
          .values({
            organizationId: input.organizationId,
            recordId: head.recordId,
            messageId: head.latest,
            expectedContextVersion: head.version,
            previousGroupKey: head.groupKey,
            previousReplyTypeId: head.replyTypeId,
            proposedGroupKey: target.groupKey,
            proposedReplyTypeId: target.id,
            appliedGroupKey: target.groupKey,
            appliedReplyTypeId: target.id,
            rules,
            confidence: "1.0000",
            reasoning: "Set by a person.",
            status: "overridden",
            provider: "human",
            acknowledgedAt: new Date(),
          })
          .returning({ id: replyTypePicks.id });
        replyTypePickId = row.id;
      }

      const { wantsDraft } = decision;
      const nextState = afterTypeChange(head.state, decision);
      await tx
        .update(records)
        .set({ groupKey: target.groupKey, replyTypeId: target.id, replyTypeSource: "human", workflowState: nextState })
        .where(eq(records.id, head.recordId));
      // A correction replaces the reading every open draft and run was built on: they end, the version goes up, and the
      // sequence of the corrected subcategory starts. The classification row follows to the new version so the fresh draft job accepts it.
      const now = new Date();
      const restart = await restartRecordWorkTx(tx, {
        organizationId: input.organizationId,
        recordId: head.recordId,
        reason: "classification_corrected",
        draftReason: "A person corrected the reply type after this draft was written.",
        followUps: decision.followUps,
        now,
        actorUserId: input.actorUserId,
      });
      await tx.update(replyTypePicks).set({ expectedContextVersion: restart.contextVersion }).where(eq(replyTypePicks.id, replyTypePickId));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        recordId: head.recordId,
        eventType: accepted ? "reply_type_pick.accepted" : "reply_type_pick.overridden",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: head.groupKey, replyTypeId: head.replyTypeId },
        toData: { groupKey: target.groupKey, replyTypeId: target.id },
        meta: { draftsRetired: restart.draftsRetired, runsEnded: restart.runsEnded, runStarted: restart.runStarted, rules },
        contextVersion: restart.contextVersion,
      });
      const draftQueued = wantsDraft ? await queuePickDraftTx(tx, { organizationId: input.organizationId, replyTypePickId, contextVersion: restart.contextVersion }) : false;
      return { personId: head.personId, groupKey: target.groupKey, replyTypeKey: target.key, draftQueued };
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
