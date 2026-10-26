import { decideReplyType, type HoldReason, type ReplyType } from "./reply-type";

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
}

export const DO_NOT_CONTACT_KEY = "do_not_contact";

export function decideApplication({ proposal, confidence, current, floor }: PolicyInput): ApplyDecision {
  const { hold } = decideReplyType(proposal, {
    confidence,
    floor,
    locked: current.replyTypeLocked,
    currentType: { id: null, groupKey: current.groupKey, systemRole: null },
    // These facts decide the draft and the follow-ups, not the hold.
    stopRequested: false,
    isContact: false,
    campaignMode: null,
    channel: null,
  });
  return hold === null ? { action: "auto_apply" } : { action: "hold", reason: hold };
}

export const HOLD_LABELS: Record<HoldReason, string> = {
  protected_customer: "The person is locked as a customer.",
  requires_review: "This reply type is checked before it applies.",
  low_confidence: "Confidence is below the confidence floor.",
};
