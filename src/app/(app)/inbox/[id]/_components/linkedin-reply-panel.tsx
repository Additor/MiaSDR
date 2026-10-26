import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import { linkedinReplyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import type { Actor } from "@/shared/errors";
import { LinkedInReplyPanelClient } from "./linkedin-reply-panel-client";

/** Server side of the LinkedIn composer: loads the account state and any open draft (AI or typed). */
export async function LinkedInReplyPanel({ conversationId, actor }: { conversationId: string; actor: Actor }) {
  const panel = await getLinkedInReplyPanel(linkedinReplyDeps(), actor, conversationId);
  if (!panel) return null;
  // A new draft id or revision remounts the client, so its text box starts from the stored draft.
  return <LinkedInReplyPanelClient key={`${panel.draft?.id ?? "none"}-${panel.draft?.revision ?? 0}-${panel.draft?.status ?? ""}`} panel={JSON.parse(JSON.stringify(panel))} />;
}
