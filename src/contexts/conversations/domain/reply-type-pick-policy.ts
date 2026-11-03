import type { HoldReason, ReplyType } from "./reply-type";

/**
 * Deterministic rules for an AI pick. The model never decides whether its pick applies: `decideReplyType` reads the
 * type's system role, the confidence floor and the customer lock, and the apply path calls it once under the conversation lock.
 */

export type { HoldReason };

/** A reply asks us to stop when ingest read the sender's own words so (`raw.stopAsked`), or when the AI picked the stop request type. */
export const stopRequestedBy = (stopAsked: boolean, proposal: Pick<ReplyType, "systemRole">): boolean => stopAsked || proposal.systemRole === "stop_request";
