import { connection } from "next/server";
import type { Actor } from "@/shared/errors";
import { loadNextInQueue } from "../_lib/next-queue";
import { NextStepClient } from "./next-step-client";
import { conversationDetail } from "./thread-data";

/**
 * Server side of the thread's Next step: the conversation's state and reply type, the reach facts Stop contacting needs, and, opened
 * from Actions, the next item of that queue. Wrap it in Suspense.
 */
export async function NextStep({
  actor,
  threadId,
  channel,
  conversationId,
  queue,
  stopOnLoad = false,
}: {
  actor: Actor;
  threadId: string;
  channel: string;
  conversationId: string;
  queue?: { view: Record<string, string> };
  /** `?stop=1`: open Stop contacting on load. */
  stopOnLoad?: boolean;
}) {
  await connection();
  const [detail, next] = await Promise.all([conversationDetail(actor, conversationId), queue ? loadNextInQueue(actor, conversationId, queue.view) : undefined]);
  const { conversation, person } = detail;
  const personName = person.name ?? person.email ?? "Unknown sender";

  return (
    <NextStepClient
      conversationId={conversation.id}
      threadId={threadId}
      channel={channel}
      personId={person.id}
      personName={personName}
      firstName={person.name?.split(/\s+/)[0] || personName}
      typeName={conversation.replyTypeName}
      closed={conversation.workflowState === "closed"}
      closedReason={conversation.closedReason}
      doNotContact={detail.policy?.doNotContact === true}
      email={person.email}
      suppressed={detail.suppressed}
      currentUserId={actor.userId}
      next={queue && next !== undefined ? next : undefined}
      stopOnLoad={stopOnLoad}
    />
  );
}
