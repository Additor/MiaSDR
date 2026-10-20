/**
 * Deterministic rule for what happens to an AI proposal. The model never decides this.
 */

export type HoldReason = "protected_customer" | "protected_stage" | "requires_review" | "low_confidence";

export type ApplyDecision = { action: "auto_apply" } | { action: "hold"; reason: HoldReason };

export interface PolicyInput {
  proposal: { categoryKey: string; subcategoryKey: string; reviewRequired: boolean; stageRank: number | null; confidence: number };
  current: { categoryKey: string | null; stageRank: number | null; categoryLocked: boolean };
  settings: { autoApplyConfidence: number; reviewOther: boolean; customerRequiresReview: boolean };
}

export const DO_NOT_CONTACT_KEY = "do_not_contact";

export function decideApplication({ proposal, current, settings }: PolicyInput): ApplyDecision {
  if (current.categoryLocked && current.categoryKey === "customer" && proposal.categoryKey !== "customer") {
    return { action: "hold", reason: "protected_customer" };
  }
  // A lower position or an unranked outcome does not pull the person back without review. Do not contact is exempt.
  if (
    current.stageRank !== null &&
    proposal.subcategoryKey !== DO_NOT_CONTACT_KEY &&
    (proposal.stageRank === null || proposal.stageRank < current.stageRank)
  ) {
    return { action: "hold", reason: "protected_stage" };
  }
  if (
    (proposal.categoryKey === "customer" && settings.customerRequiresReview) ||
    proposal.reviewRequired ||
    (proposal.categoryKey === "other" && settings.reviewOther)
  ) {
    return { action: "hold", reason: "requires_review" };
  }
  if (proposal.confidence < settings.autoApplyConfidence) return { action: "hold", reason: "low_confidence" };
  return { action: "auto_apply" };
}

export const HOLD_LABELS: Record<HoldReason, string> = {
  protected_customer: "The person is locked as Existing customer.",
  protected_stage: "The proposal moves the person to a lower position.",
  requires_review: "This category always needs a person to confirm.",
  low_confidence: "Confidence is below the auto-apply threshold.",
};
