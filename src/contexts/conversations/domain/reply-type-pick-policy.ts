import type { HoldReason, ReplyType } from "./reply-type";
import { detectsStopRequest } from "./stop-request";

/**
 * Deterministic rules for an AI pick. The model never decides whether its pick applies: `decideReplyType` reads the
 * type's Check rule, the confidence floor and the customer lock, and the apply path calls it once under the record lock.
 */

export type { HoldReason };

/** A reply asks us to stop when the sender's own words say so, or when the AI picked the stop request type. */
export const stopRequestedBy = (messageText: string, proposal: Pick<ReplyType, "systemRole">): boolean =>
  detectsStopRequest(messageText) || proposal.systemRole === "stop_request";

export const HOLD_LABELS: Record<HoldReason, string> = {
  protected_customer: "The person is locked as a customer.",
  requires_review: "This reply type is checked before it applies.",
  low_confidence: "Confidence is below the confidence floor.",
};
