import { AI_PICK_CONFIDENCE_FLOOR, holdReasonOf, type HoldReason, type SystemRole, type TypeRules } from "@/contexts/conversations/domain/reply-type";

/**
 * Pure rules for the thread's type line: which AI pick it speaks for, whether it waits for a person, and the short texts
 * it shows. The server component feeds these; nothing here reads the database.
 */

export interface PickFacts {
  id: string;
  status: string;
  provider: string | null;
  latest: boolean;
  current: boolean;
  proposed: { groupKey: string | null; name: string | null };
  applied: { groupKey: string | null; name: string | null };
  appliedReplyTypeId: string | null;
  proposedSystemRole: SystemRole | null;
  holdReason: HoldReason | null;
  stopRequested: boolean;
  confidence: number | null;
  reasoning: string | null;
  error: string | null;
}

/** The pick of the latest reply, newest first, a stale one only when nothing else exists. */
export function latestPick<T extends Pick<PickFacts, "latest" | "status">>(entries: readonly T[]): T | undefined {
  const latest = entries.filter((e) => e.latest);
  return latest.find((e) => e.status !== "stale") ?? latest[0];
}

/** The AI's pick of the latest reply, for Why. A person's pick has no reasoning to show. */
export function latestAiPick<T extends Pick<PickFacts, "latest" | "status" | "provider">>(entries: readonly T[]): T | undefined {
  return latestPick(entries.filter((e) => e.provider !== "human"));
}

export type DecisionKind = "stop" | "held";

/** A stop request can wait with no pick: the reply's own words asked, before any pick read it. */
export type TypeDecision<T extends PickFacts = PickFacts> = { kind: "stop"; pick: T | null } | { kind: "held"; pick: T } | null;

/**
 * What the type line asks of a person, if anything. A stop request comes first: Accept would only change the type, so the
 * line offers Review stop request instead. Then a held pick (Accept). A person already marked do not contact, or an email
 * address on the suppression list, has nothing left to stop. An applied pick asks nothing.
 */
export function typeDecision<T extends PickFacts>(
  pick: T | undefined,
  reach: { doNotContact: boolean; suppressed: boolean; channel: string },
  conversation: { groupKey: string | null; replyTypeId: string | null; stopReviewOpen: boolean },
): TypeDecision<T> {
  const stopped = reach.doNotContact || (reach.channel === "email" && reach.suppressed);
  if (conversation.stopReviewOpen && !stopped) return { kind: "stop", pick: pick?.latest ? pick : null };
  if (!pick || !pick.latest) return null;
  if (pick.status === "proposed" && pick.current && pick.proposed.name && pick.proposedSystemRole !== "stop_request") return { kind: "held", pick };
  return null;
}

const HOLD_TEXT: Record<HoldReason, string> = {
  protected_customer: "The person is locked as Existing customer. Accept takes them out of it.",
  stop_request: "A stop request waits for a person.",
  low_confidence: `The AI's confidence is under the ${Math.round(AI_PICK_CONFIDENCE_FLOOR * 100)}% floor.`,
};

/** Why a held pick waits, in one sentence. An unknown reason, or none, gets the fallback. */
export const holdText = (reason: string | null | undefined): string => {
  const known = holdReasonOf(reason);
  return known ? HOLD_TEXT[known] : "It waits for you.";
};

/** "Draft · Follow-ups keep going": what a type's rules do once it applies. */
export function rulesSummary(rules: Pick<TypeRules, "replyDraft" | "followUps">): string {
  return `${rules.replyDraft ? "Draft" : "No draft"} · ${rules.followUps === "continue" ? "Follow-ups keep going" : "Follow-ups stop"}`;
}

/** The reply panel's line when no draft exists because the conversation's type writes none. Null when the type writes one. */
export function noDraftReason(type: { name: string | null; rules: Pick<TypeRules, "replyDraft"> | null } | null): string | null {
  if (!type?.rules || type.rules.replyDraft || !type.name) return null;
  return `No draft: ${type.name} replies get none.`;
}

/** "82% confident" from a 0..1 confidence. */
export const confidenceText = (confidence: number) => `${Math.round(confidence * 100)}% confident`;

/** The toast after Undo, from what the undo retired. */
export function undoMessage(result: { draftsRetired: number; runEnded: boolean; draftJobCancelled?: boolean }): string {
  const parts = [
    result.draftsRetired > 0 ? `retired ${result.draftsRetired} ${result.draftsRetired === 1 ? "draft" : "drafts"}` : null,
    result.draftJobCancelled ? "cancelled the draft the AI was about to write" : null,
    result.runEnded ? "ended follow-ups" : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "AI pick undone. Nothing else changed.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `AI pick undone. It ${list}.`;
}

/** What the reply panel says when no draft is open, read from the conversation behind the thread. */
export function draftState(
  detail: {
    conversation: { groupKey: string | null; replyTypeId: string | null; stopReviewOpen: boolean; replyTypeName: string | null; replyTypeRules: Pick<TypeRules, "replyDraft"> | null; draftJobPending: boolean };
    replyTypePicks: readonly PickFacts[];
    policy: { doNotContact: boolean } | null;
    suppressed: boolean;
  },
  channel: string,
): { noDraft: string | null; drafting: boolean; decisionWaiting: boolean } {
  return {
    noDraft: noDraftReason({ name: detail.conversation.replyTypeName, rules: detail.conversation.replyTypeRules }),
    drafting: detail.conversation.draftJobPending,
    decisionWaiting: typeDecision(latestPick(detail.replyTypePicks), { doNotContact: detail.policy?.doNotContact === true, suppressed: detail.suppressed, channel }, detail.conversation) !== null,
  };
}

/** The key of one decision on the type line: a new key is a new question for the person. */
export const decisionKey = (decision: { kind: DecisionKind; pickId: string | null } | null): string | null => (decision ? `${decision.kind}:${decision.pickId}` : null);

/**
 * What the type line shows around a decision a person just answered. The answer hides the decision at once, so a second
 * click cannot send it again before the refresh lands, and the done line stays once the decision is gone. A new decision
 * (another key) clears the done line and shows itself.
 */
export function decisionView(current: string | null, settled: { key: string; text: string } | null): { showDecision: boolean; done: string | null } {
  if (!settled) return { showDecision: current !== null, done: null };
  if (current === null || current === settled.key) return { showDecision: false, done: settled.text };
  return { showDecision: true, done: null };
}

/** The badge of an AI pick in the history, only while it waits for a person or failed. */
export function pickBadge(e: { status: string }): "Failed" | "Held for a check" | null {
  if (e.status === "failed") return "Failed";
  if (e.status === "proposed") return "Held for a check";
  return null;
}
