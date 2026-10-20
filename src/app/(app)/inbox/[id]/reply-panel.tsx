import { getReplyPanel } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import type { Actor } from "@/shared/errors";
import { loadNextInQueue } from "./next-queue";
import { ReplyPanelClient } from "./reply-panel-client";

/**
 * Server side of the draft slot: loads the AI state for the thread. Renders nothing for non-email threads. A thread opened from
 * Actions also gets the next item of that queue, so a sent reply can offer the step after it.
 */
export async function ReplyPanel({ conversationId, actor, queue }: { conversationId: string; actor: Actor; queue?: { recordId: string; view: Record<string, string> } }) {
  const panel = await getReplyPanel(replyDeps(), actor, conversationId);
  if (!panel) return null;
  const next = queue ? await loadNextInQueue(actor, queue.recordId, queue.view) : undefined;
  return <ReplyPanelClient panel={JSON.parse(JSON.stringify(panel))} next={next ?? null} fromQueue={Boolean(queue) && next !== undefined} />;
}
