import type { HoldReason, ReplyType } from "./reply-type";
import { detectsStopRequest } from "./stop-request";

/**
 * Deterministic rules for an AI pick. The model never decides whether its pick applies: `decideReplyType` reads the
 * type's system role, the confidence floor and the customer lock, and the apply path calls it once under the conversation lock.
 */

export type { HoldReason };

/** A reply asks us to stop when the sender's own words say so, or when the AI picked the stop request type. */
export const stopRequestedBy = (messageText: string, proposal: Pick<ReplyType, "systemRole">): boolean =>
  detectsStopRequest(messageText) || proposal.systemRole === "stop_request";
