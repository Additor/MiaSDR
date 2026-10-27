import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import { linkedinReplyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import type { Actor } from "@/shared/errors";
import { draftState } from "../_lib/type-line";
import { LinkedInReplyPanelClient } from "./linkedin-reply-panel-client";
import { recordDetail } from "./thread-data";

/** Server side of the LinkedIn composer: loads the account state and any open draft (AI or typed). */
export async function LinkedInReplyPanel({ conversationId, recordId, actor }: { conversationId: string; recordId: string; actor: Actor }) {
  const [panel, detail] = await Promise.all([getLinkedInReplyPanel(linkedinReplyDeps(), actor, conversationId), recordDetail(actor, recordId)]);
  if (!panel) return null;
  const state = draftState(detail, "linkedin");
  // A new draft id or revision remounts the client, so its text box starts from the stored draft.
  return (
    <LinkedInReplyPanelClient
      key={`${panel.draft?.id ?? "none"}-${panel.draft?.revision ?? 0}-${panel.draft?.status ?? ""}`}
      panel={JSON.parse(JSON.stringify(panel))}
      noDraft={state.noDraft}
      drafting={state.drafting}
    />
  );
}
