import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import { linkedinReplyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import type { Actor } from "@/shared/errors";
import { draftState } from "../_lib/type-line";
import { LinkedInReplyPanelClient } from "./linkedin-reply-panel-client";
import { conversationDetail } from "./thread-data";

/** Server side of the LinkedIn composer: loads the account state and any open draft (AI or typed). */
export async function LinkedInReplyPanel({ threadId, conversationId, actor }: { threadId: string; conversationId: string; actor: Actor }) {
  const [panel, detail] = await Promise.all([getLinkedInReplyPanel(linkedinReplyDeps(), actor, threadId), conversationDetail(actor, conversationId)]);
  if (!panel) return null;
  const state = draftState(detail, "linkedin");
  return (
    <LinkedInReplyPanelClient
      panel={JSON.parse(JSON.stringify(panel))}
      noDraft={state.noDraft}
      drafting={state.drafting}
    />
  );
}
