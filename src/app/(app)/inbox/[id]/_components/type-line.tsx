import { connection } from "next/server";
import type { Actor } from "@/shared/errors";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { watchedDraftStatus } from "../_lib/draft-watch";
import { loadNextInQueue } from "../_lib/next-queue";
import { latestAiPick, latestPick, rulesSummary, typeDecision } from "../_lib/type-line";
import { DraftWatch } from "./draft-watch-client";
import { TypeLineClient } from "./type-line-client";
import { recordDetail } from "./thread-data";

/**
 * Server side of the type line under the latest message: the record's reply type, its group and what its rules do, the AI's
 * pick of the latest reply for Why, and the decision that pick waits for, if any. Email and LinkedIn threads show the same
 * line. Wrap it in Suspense.
 */
export async function TypeLine({ actor, conversationId, channel, recordId, queue }: { actor: Actor; conversationId: string; channel: string; recordId: string; queue?: { view: Record<string, string> } }) {
  await connection();
  const [detail, next] = await Promise.all([recordDetail(actor, recordId), queue ? loadNextInQueue(actor, recordId, queue.view) : undefined]);
  const { record, person } = detail;
  const doNotContact = detail.policy?.doNotContact === true;
  const pick = latestPick(detail.replyTypePicks);
  const aiPick = latestAiPick(detail.replyTypePicks);
  const decision = typeDecision(pick, { doNotContact, suppressed: detail.suppressed, channel }, record);
  const personName = person.name ?? person.email ?? "Unknown sender";
  const typeName = record.replyTypeName ?? (record.groupKey ? groupLabel(record.groupKey) : null);

  const draftStatus = watchedDraftStatus(detail.drafts, conversationId, record.contextVersion);

  return (
    <>
      <TypeLineClient
      recordId={record.id}
      conversationId={conversationId}
      contextVersion={record.contextVersion}
      personName={personName}
      type={
        typeName
          ? {
              name: typeName,
              // A type named like its group ("Other") says the group once.
              group: record.groupKey && groupLabel(record.groupKey).toLowerCase() !== typeName.toLowerCase() ? groupLabel(record.groupKey) : null,
              rules: record.replyTypeRules ? rulesSummary(record.replyTypeRules) : null,
              source: record.replyTypeSource,
              locked: record.replyTypeLocked,
            }
          : null
      }
      currentReplyTypeId={record.replyTypeId}
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
              pickId: decision.pick.id,
              proposed: decision.pick.proposed.name,
              proposedGroup: decision.pick.proposed.groupKey ? groupLabel(decision.pick.proposed.groupKey) : null,
              confidence: decision.pick.confidence,
              holdReason: decision.pick.holdReason,
            }
          : null
      }
      // Under a draft that waits for approval, Approve and send stays the one filled button.
      draftAwaits={detail.drafts.some((d) => d.conversationId === conversationId && d.status === "awaiting_review")}
      closed={record.workflowState === "closed"}
      stop={{ recordId: record.id, conversationId, channel, personId: person.id, personName, email: person.email, suppressed: detail.suppressed, doNotContact }}
      next={queue && next !== undefined ? next : undefined}
      />
      {/* Refreshes the page while a draft is on its way, so it shows up without a reload. */}
      <DraftWatch contextVersion={record.contextVersion} draftStatus={draftStatus} workflowState={record.workflowState} drafting={record.draftJobPending} />
    </>
  );
}
