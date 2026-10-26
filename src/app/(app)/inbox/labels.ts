import type { DraftStatus } from "@/contexts/conversations/domain/draft-status";
import { workflowLabel } from "@/contexts/conversations/domain/reply-handling";
import { humanizeToken } from "@/shared/humanize";

/** Reply draft statuses as the person reads them. `stale` shows as "Out of date" everywhere. */
const DRAFT_STATUS_LABEL: Readonly<Record<string, string>> = {
  generating: "Drafting",
  awaiting_review: "Awaiting review",
  sending: "Sending",
  sent: "Sent",
  discarded: "Discarded",
  stale: "Out of date",
  failed: "Failed",
  delivery_uncertain: "Delivery not confirmed",
} satisfies Record<DraftStatus, string>;

export const draftStatusLabel = (status: string) => DRAFT_STATUS_LABEL[status] ?? humanizeToken(status);

const REPLY_TYPE_SOURCE_LABEL: Record<string, string> = { ai: "AI", human: "set by a person", integration: "integration" };

/** Who set a thread's category, for the chip next to the category name. */
export const replyTypeSourceLabel = (source: string) => REPLY_TYPE_SOURCE_LABEL[source] ?? humanizeToken(source);

/** Who has to act next on a conversation, from the record's workflow state. */
export function waitingOn(workflowState: string): string {
  if (workflowState === "action_required" || workflowState === "error") return "You";
  if (workflowState === "waiting") return "The person";
  if (workflowState === "classifying") return "AI";
  return "No one";
}

export { workflowLabel };
