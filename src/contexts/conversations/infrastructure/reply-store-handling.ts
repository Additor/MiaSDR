import { pickMayBecome } from "./reply-store-shared";
import { PICK_FROM } from "../domain/reply-type-pick";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createSuppressionStore } from "@/contexts/outreach/infrastructure/suppression-store";
import { followUpStop } from "../after-reply/infrastructure/follow-up-stop";
import { db } from "@/platform/db/client";
import { personTypeDecisionTx, queuePickDraftTx, restartConversationWorkTx } from "./restart-conversation-work";
import { personReviewedStopsTx } from "./stop-review";
import { replyTypePicks, threads, drafts, events, people, conversations, replyTypes } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError, viaMeta } from "@/shared/errors";
import type { ReplyStore } from "../application/reply-ports";
import { afterTypeChange } from "../domain/workflow-state";
import { typeRulesOf } from "../domain/reply-type";
import { lockAfterPersonMove } from "../domain/reply-handling";

/** What a person decides about a reply: a classification of their own, or suppressing the sender. */
export const replyHandlingMethods: Pick<ReplyStore, "applyHumanReplyTypePick" | "suppressSender"> = {
  async applyHumanReplyTypePick(input) {
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({
          conversationId: conversations.id,
          personId: conversations.personId,
          replyTypeSetId: conversations.replyTypeSetId,
          version: conversations.contextVersion,
          latest: conversations.latestInboundMessageId,
          groupKey: conversations.groupKey,
          replyTypeId: conversations.replyTypeId,
          locked: conversations.replyTypeLocked,
          state: conversations.workflowState,
        })
        .from(threads)
        .innerJoin(conversations, eq(conversations.id, threads.conversationId))
        .where(and(eq(threads.id, input.threadId), eq(threads.organizationId, input.organizationId)))
        .for("no key update", { of: conversations });
      if (!head) throw new NotFoundError("Conversation not found");
      if (!head.latest) throw new ConflictError("There is no inbound message to classify.");
      if (head.version !== input.expectedContextVersion) throw new ConflictError("Reply handling changed after you opened it. Reload and choose the type again.");
      if (head.state === "closed") throw new ConflictError("Reply handling is marked done. Reopen it before you change the type.");

      // The pick this decision settles. A failed or stale row names no type and no previous type: it stays as the conversation
      // of what went wrong, and the person's pick goes in as a row of its own.
      const [existing] = await tx
        .select()
        .from(replyTypePicks)
        .where(
          and(
            eq(replyTypePicks.messageId, head.latest),
            eq(replyTypePicks.expectedContextVersion, head.version),
            inArray(replyTypePicks.status, [...PICK_FROM.overridden]),
          ),
        );

      let targetId: string | null;
      if (input.replyTypeKey === null) {
        if (!existing || existing.status !== "proposed" || !existing.proposedReplyTypeId) throw new ConflictError("There is no AI proposal to accept.");
        targetId = existing.proposedReplyTypeId;
      } else {
        const [found] = await tx
          .select({ id: replyTypes.id })
          .from(replyTypes)
          .where(and(eq(replyTypes.replyTypeSetId, head.replyTypeSetId), eq(replyTypes.key, input.replyTypeKey)));
        if (!found) throw new ValidationError("That reply type does not exist.");
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
      const decision = await personTypeDecisionTx(tx, {
        organizationId: input.organizationId,
        conversation: { id: head.conversationId, latestInboundMessageId: head.latest, replyTypeLocked: head.locked },
        target: { groupKey: target.groupKey, systemRole: target.systemRole, rules },
      });
      // The person chose this type, so a move out of the customer group unlocks without a second confirmation.
      const locked = lockAfterPersonMove(target);

      let replyTypePickId: string | null = null;
      if (existing) {
        await tx
          .update(replyTypePicks)
          .set({
            status: accepted ? "accepted" : "overridden",
            appliedGroupKey: target.groupKey,
            appliedReplyTypeId: target.id,
            rules,
            // The lock before the first pick of this row stays: undo goes back to it. A stop request read from the text
            // is kept on the row, so the start sweep sees it (`stopRequestedSql`).
            response: sql`(case when ${replyTypePicks.response} ? 'previousLocked' then ${replyTypePicks.response}
              else coalesce(${replyTypePicks.response}, '{}'::jsonb) || jsonb_build_object('previousLocked', ${head.locked}::boolean) end)
              || ${decision.stopRequested ? sql`'{"stopRequested":true}'::jsonb` : sql`'{}'::jsonb`}`,
          })
          .where(and(eq(replyTypePicks.id, existing.id), pickMayBecome(accepted ? "accepted" : "overridden")));
        replyTypePickId = existing.id;
      }

      const { wantsDraft } = decision;
      const nextState = afterTypeChange(head.state, decision);
      await tx
        .update(conversations)
        .set({ groupKey: target.groupKey, replyTypeId: target.id, replyTypeSource: "human", replyTypeLocked: locked, workflowState: nextState })
        .where(eq(conversations.id, head.conversationId));
      // A correction replaces the reading every open draft and run was built on: they end, the version goes up, and the
      // sequence of the corrected subcategory starts. The pick follows to the new version so the fresh draft job accepts it.
      const now = new Date();
      const restart = await restartConversationWorkTx(tx, {
        organizationId: input.organizationId,
        conversationId: head.conversationId,
        reason: "type_corrected",
        draftReason: "A person corrected the reply type after this draft was written.",
        followUps: decision.followUps,
        now,
        actorUserId: input.actorUserId,
      });
      if (replyTypePickId) {
        await tx.update(replyTypePicks).set({ expectedContextVersion: restart.contextVersion }).where(eq(replyTypePicks.id, replyTypePickId));
      } else {
        // A new row takes the new version at once: the old version's slot may hold a failed or stale pick.
        const [row] = await tx
          .insert(replyTypePicks)
          .values({
            organizationId: input.organizationId,
            conversationId: head.conversationId,
            messageId: head.latest,
            expectedContextVersion: restart.contextVersion,
            previousGroupKey: head.groupKey,
            previousReplyTypeId: head.replyTypeId,
            proposedGroupKey: target.groupKey,
            proposedReplyTypeId: target.id,
            appliedGroupKey: target.groupKey,
            appliedReplyTypeId: target.id,
            rules,
            response: { previousLocked: head.locked, ...(decision.stopRequested ? { stopRequested: true } : {}) },
            confidence: "1.0000",
            reasoning: "Set by a person.",
            status: "overridden",
            provider: "human",
          })
          .returning({ id: replyTypePicks.id });
        replyTypePickId = row.id;
      }
      await personReviewedStopsTx(tx, { organizationId: input.organizationId, conversationId: head.conversationId, actorUserId: input.actorUserId, via: input.via, now });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        conversationId: head.conversationId,
        eventType: accepted ? "reply_type_pick.accepted" : "reply_type_pick.overridden",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: head.groupKey, replyTypeId: head.replyTypeId, replyTypeLocked: head.locked },
        toData: { groupKey: target.groupKey, replyTypeId: target.id, replyTypeLocked: locked },
        meta: { draftsRetired: restart.draftsRetired, runsEnded: restart.runsEnded, runStarted: restart.runStarted, rules, ...viaMeta(input.via) },
        contextVersion: restart.contextVersion,
      });
      const draftQueued = wantsDraft ? await queuePickDraftTx(tx, { organizationId: input.organizationId, replyTypePickId, contextVersion: restart.contextVersion }) : false;
      return { personId: head.personId, conversationId: head.conversationId, contextVersion: restart.contextVersion, groupKey: target.groupKey, replyTypeKey: target.key, draftQueued, draftsRetired: restart.draftsRetired, runStarted: restart.runStarted, runEnded: restart.runsEnded > 0 };
    });
  },

  async suppressSender(input) {
    // One transaction: the suppression, the retired draft and the event commit together or not at all.
    return db.transaction(async (tx) => {
      const [head] = await tx
        .select({ conversationId: conversations.id, personId: conversations.personId, email: people.email })
        .from(threads)
        .innerJoin(conversations, eq(conversations.id, threads.conversationId))
        .innerJoin(people, eq(people.id, conversations.personId))
        .where(and(eq(threads.id, input.threadId), eq(threads.organizationId, input.organizationId)));
      if (!head) throw new NotFoundError("Conversation not found");
      if (!head.email) throw new ConflictError("This person has no email address to suppress.");
      const email = head.email.toLowerCase();
      await createSuppressionStore(followUpStop).suppressEmailTx(tx, { organizationId: input.organizationId, email, reason: "unsubscribed", note: "Asked to stop in a reply." });
      // A reply that is waiting for review would be refused at send time anyway; retire it now.
      await tx.update(drafts).set({ status: "stale", error: "The sender was suppressed." }).where(and(eq(drafts.conversationId, head.conversationId), eq(drafts.status, "awaiting_review")));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: head.personId,
        conversationId: head.conversationId,
        eventType: "contact.suppressed",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { threadId: input.threadId },
      });
      return { email };
    });
  },
};
