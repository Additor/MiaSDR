import { connection } from "next/server";
import type { Actor } from "@/shared/errors";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { watchedDraftStatus } from "../_lib/draft-watch";
import { loadNextInQueue } from "../_lib/next-queue";
import { latestAiPick, latestPick, rulesSummary, typeDecision } from "../_lib/type-line";
import { DraftWatch } from "./draft-watch-client";
import { TypeLineClient } from "./type-line-client";
import { conversationDetail } from "./thread-data";

/**
 * Server side of the type line under the latest message: the conversation's reply type, its group and what its rules do, the AI's
 * pick of the latest reply for Why, and the decision that pick waits for, if any. Email and LinkedIn threads show the same
 * line. Wrap it in Suspense.
 */
export async function TypeLine({ actor, threadId, channel, conversationId, queue }: { actor: Actor; threadId: string; channel: string; conversationId: string; queue?: { view: Record<string, string> } }) {
  await connection();
  const [detail, next] = await Promise.all([conversationDetail(actor, conversationId), queue ? loadNextInQueue(actor, conversationId, queue.view) : undefined]);
  const { conversation, person } = detail;
  const doNotContact = detail.policy?.doNotContact === true;
  const pick = latestPick(detail.replyTypePicks);
  const aiPick = latestAiPick(detail.replyTypePicks);
  const decision = typeDecision(pick, { doNotContact, suppressed: detail.suppressed, channel }, conversation);
  const personName = person.name ?? person.email ?? "Unknown sender";
  const typeName = conversation.replyTypeName ?? (conversation.groupKey ? groupLabel(conversation.groupKey) : null);

  const draftStatus = watchedDraftStatus(detail.drafts, threadId, conversation.contextVersion);

  return (
    <>
      <TypeLineClient
      conversationId={conversation.id}
      threadId={threadId}
      contextVersion={conversation.contextVersion}
      personName={personName}
      type={
        typeName
          ? {
              name: typeName,
              // A type named like its group ("Other") says the group once.
              group: conversation.groupKey && groupLabel(conversation.groupKey).toLowerCase() !== typeName.toLowerCase() ? groupLabel(conversation.groupKey) : null,
              rules: conversation.replyTypeRules ? rulesSummary(conversation.replyTypeRules) : null,
              source: conversation.replyTypeSource,
              locked: conversation.replyTypeLocked,
            }
          : null
      }
      currentReplyTypeId={conversation.replyTypeId}
      types={detail.replyTypes.map(({ id, key, groupKey, name, systemRole }) => ({ id, key, groupKey, name, systemRole }))}
      why={
        aiPick
          ? {
              failed: aiPick.status === "failed" ? (aiPick.error ?? "No reason was given.") : null,
              name: aiPick.proposed.name,
              group: aiPick.proposed.groupKey ? groupLabel(aiPick.proposed.groupKey) : null,
              confidence: aiPick.confidence,
              reasoning: aiPick.reasoning,
            }
          : null
      }
      decision={
        decision
          ? {
              kind: decision.kind,
              pickId: decision.pick?.id ?? null,
              proposed: decision.pick?.proposed.name ?? null,
              proposedGroup: decision.pick?.proposed.groupKey ? groupLabel(decision.pick.proposed.groupKey) : null,
              confidence: decision.pick?.confidence ?? null,
              holdReason: decision.pick?.holdReason ?? null,
            }
          : null
      }
      // Under a draft that waits for approval, Approve and send stays the one filled button.
      draftAwaits={detail.drafts.some((d) => d.threadId === threadId && d.status === "awaiting_review")}
      closed={conversation.workflowState === "closed"}
      stop={{ conversationId: conversation.id, threadId, channel, personId: person.id, personName, email: person.email, suppressed: detail.suppressed, doNotContact }}
      next={queue && next !== undefined ? next : undefined}
      />
      {/* Refreshes the page while a draft is on its way, so it shows up without a reload. */}
      <DraftWatch contextVersion={conversation.contextVersion} draftStatus={draftStatus} workflowState={conversation.workflowState} drafting={conversation.draftJobPending} />
    </>
  );
}
