import { connection } from "next/server";
import type { Actor } from "@/shared/errors";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";
import { loadNextInQueue } from "../next-queue";
import { NextStepClient } from "./next-step-client";
import { recordDetail } from "./thread-data";

/**
 * Server side of the thread's Next step: the record's category and state, the AI's latest reading for Change category, and,
 * opened from Actions, the next item of that queue. Wrap it in Suspense.
 */
export async function NextStep({
  actor,
  conversationId,
  channel,
  recordId,
  queue,
}: {
  actor: Actor;
  conversationId: string;
  channel: string;
  recordId: string;
  queue?: { view: Record<string, string> };
}) {
  await connection();
  const [detail, next] = await Promise.all([recordDetail(actor, recordId), queue ? loadNextInQueue(actor, recordId, queue.view) : undefined]);
  const { record, person } = detail;
  const personName = person.name ?? person.email ?? "Unknown sender";
  // The AI's reading of the latest reply, not a person's correction of it, so Change category can show what it replaces.
  const reading = detail.classifications.find((c) => c.latest && c.provider !== "human" && c.status !== "failed" && c.proposed.name);

  return (
    <NextStepClient
      recordId={record.id}
      conversationId={conversationId}
      channel={channel}
      personId={person.id}
      personName={personName}
      firstName={person.name?.split(/\s+/)[0] || personName}
      category={{
        label: record.categoryKey ? `${categoryLabel(record.categoryKey)}${record.subcategoryName ? `: ${record.subcategoryName}` : ""}` : null,
        source: record.categorySource,
        locked: record.categoryLocked,
        subcategoryId: record.subcategoryId,
      }}
      contextVersion={record.contextVersion}
      stages={detail.stages}
      aiReading={reading ? { name: `${categoryLabel(reading.proposed.categoryKey)}: ${reading.proposed.name}`, confidence: reading.confidence, reasoning: reading.reasoning } : null}
      closed={record.workflowState === "closed"}
      closedReason={record.closedReason}
      doNotContact={detail.policy?.doNotContact === true}
      email={person.email}
      suppressed={detail.suppressed}
      currentUserId={actor.userId}
      next={queue && next !== undefined ? next : undefined}
    />
  );
}
