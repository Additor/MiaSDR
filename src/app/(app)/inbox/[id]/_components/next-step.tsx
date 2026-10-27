import { connection } from "next/server";
import type { Actor } from "@/shared/errors";
import { loadNextInQueue } from "../_lib/next-queue";
import { NextStepClient } from "./next-step-client";
import { recordDetail } from "./thread-data";

/**
 * Server side of the thread's Next step: the record's state and reply type, the reach facts Stop contacting needs, and, opened
 * from Actions, the next item of that queue. Wrap it in Suspense.
 */
export async function NextStep({
  actor,
  conversationId,
  channel,
  recordId,
  queue,
  stopOnLoad = false,
}: {
  actor: Actor;
  conversationId: string;
  channel: string;
  recordId: string;
  queue?: { view: Record<string, string> };
  /** `?stop=1`: open Stop contacting on load. */
  stopOnLoad?: boolean;
}) {
  await connection();
  const [detail, next] = await Promise.all([recordDetail(actor, recordId), queue ? loadNextInQueue(actor, recordId, queue.view) : undefined]);
  const { record, person } = detail;
  const personName = person.name ?? person.email ?? "Unknown sender";

  return (
    <NextStepClient
      recordId={record.id}
      conversationId={conversationId}
      channel={channel}
      personId={person.id}
      personName={personName}
      firstName={person.name?.split(/\s+/)[0] || personName}
      typeName={record.replyTypeName}
      closed={record.workflowState === "closed"}
      closedReason={record.closedReason}
      doNotContact={detail.policy?.doNotContact === true}
      email={person.email}
      suppressed={detail.suppressed}
      currentUserId={actor.userId}
      next={queue && next !== undefined ? next : undefined}
      stopOnLoad={stopOnLoad}
    />
  );
}
