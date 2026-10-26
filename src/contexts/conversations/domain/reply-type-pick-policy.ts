import { decideReplyType, type HoldReason, type ReplyType } from "./reply-type";
import { detectsStopRequest } from "./stop-request";

/**
 * Deterministic rule for what happens to an AI pick: it applies, or it waits for a person. The model never decides
 * this. `decideReplyType` reads the type's Check rule, the confidence floor and the customer lock; this file only
 * turns its hold into the decision the apply path stores.
 */

export type { HoldReason };

export type ApplyDecision = { action: "auto_apply" } | { action: "hold"; reason: HoldReason };

export interface PolicyInput {
  proposal: Pick<ReplyType, "groupKey" | "rules">;
  confidence: number;
  current: { groupKey: string | null; replyTypeLocked: boolean };
  /** The organization's confidence floor. */
  floor: number;
  /** The reply asks us to stop (`stopRequestedBy`). It decides the draft, not the hold. */
  stopRequested?: boolean;
}

export interface AiPickDecision {
  application: ApplyDecision;
  /** Once applied, the AI writes a reply draft. */
  wantsDraft: boolean;
}

function decide({ proposal, confidence, current, floor, stopRequested = false }: PolicyInput) {
  return decideReplyType(proposal, {
    confidence,
    floor,
    locked: current.replyTypeLocked,
    currentType: { id: null, groupKey: current.groupKey, systemRole: null },
    stopRequested,
    // These facts decide the follow-ups, which the apply path reads under the record lock.
    isContact: false,
    campaignMode: null,
    channel: null,
  });
}

export function decideApplication(input: PolicyInput): ApplyDecision {
  const { hold } = decide(input);
  return hold === null ? { action: "auto_apply" } : { action: "hold", reason: hold };
}

/** Whether the pick applies, and whether it then wants a draft. A stop request never gets one. */
export function decideAiPick(input: PolicyInput): AiPickDecision {
  const { hold, wantsDraft } = decide(input);
  return { application: hold === null ? { action: "auto_apply" } : { action: "hold", reason: hold }, wantsDraft };
}

/** A reply asks us to stop when the sender's own words say so, or when the AI picked the stop request type. */
export const stopRequestedBy = (messageText: string, proposal: Pick<ReplyType, "systemRole">): boolean =>
  detectsStopRequest(messageText) || proposal.systemRole === "stop_request";

export const HOLD_LABELS: Record<HoldReason, string> = {
  protected_customer: "The person is locked as a customer.",
  requires_review: "This reply type is checked before it applies.",
  low_confidence: "Confidence is below the confidence floor.",
};
