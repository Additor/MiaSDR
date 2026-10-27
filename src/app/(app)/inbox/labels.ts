import type { DraftStatus } from "@/contexts/conversations/domain/draft-status";
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

const REPLY_TYPE_SOURCE_TIP: Record<string, string> = { ai: "Picked by the AI", human: "Set by a person", integration: "Set by an integration" };

/** Who set a thread's reply type, for the tip on the sparkle or person mark of the type line. */
export const replyTypeSourceTip = (source: string) => REPLY_TYPE_SOURCE_TIP[source] ?? `Set by ${humanizeToken(source).toLowerCase()}`;
