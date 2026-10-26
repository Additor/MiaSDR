import type { HoldReason, SystemRole, TypeRules } from "@/contexts/conversations/domain/reply-type";

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
  acknowledged: boolean;
  proposed: { groupKey: string | null; name: string | null };
  applied: { groupKey: string | null; name: string | null };
  /** The rules the pick was decided with: only Check after asks for Looks right. */
  rules: Pick<TypeRules, "checkMode"> | null;
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

export type TypeDecision<T extends PickFacts = PickFacts> = { kind: "stop" | "held" | "looks_right"; pick: T } | null;

/**
 * What the type line asks of a person, if anything. A stop request comes first: Accept would only change the type, so the
 * line offers Review stop request instead. Then a held pick (Accept), then an applied pick that waits for Looks right. A
 * person already marked do not contact, or an email address on the suppression list, has nothing left to stop. An applied
 * pick asks only when its type is checked after it applies, and only while the record still has that type: a person who
 * changed the type since has answered it.
 */
export function typeDecision<T extends PickFacts>(
  pick: T | undefined,
  reach: { doNotContact: boolean; suppressed: boolean; channel: string },
  record: { groupKey: string | null; replyTypeName: string | null },
): TypeDecision<T> {
  if (!pick || !pick.latest) return null;
  const applied = pick.status === "auto_applied" && !pick.acknowledged && pick.applied.groupKey === record.groupKey && pick.applied.name === record.replyTypeName;
  const unchecked = applied && (pick.rules === null || pick.rules.checkMode === "after");
  const open = (pick.status === "proposed" && pick.current) || applied;
  const stopAsked = pick.stopRequested || pick.proposedSystemRole === "stop_request";
  const stopped = reach.doNotContact || (reach.channel === "email" && reach.suppressed);
  if (open && stopAsked && !stopped) return { kind: "stop", pick };
  if (pick.status === "proposed" && pick.current && pick.proposed.name && pick.proposedSystemRole !== "stop_request") return { kind: "held", pick };
  if (unchecked) return { kind: "looks_right", pick };
  return null;
}

/** Why a held pick waits, in one sentence. */
export const HOLD_TEXT: Record<HoldReason, string> = {
  protected_customer: "The person is locked as Existing customer.",
  requires_review: "This type waits for a person to check it.",
  low_confidence: "The AI's confidence is under the confidence floor.",
};

/** "Draft · Follow-ups keep going": what a type's rules do once it applies. */
export function rulesSummary(rules: Pick<TypeRules, "replyDraft" | "followUps">): string {
  return `${rules.replyDraft ? "Draft" : "No draft"} · ${rules.followUps === "continue" ? "Follow-ups keep going" : "Follow-ups stop"}`;
}

/** The reply panel's line when no draft exists because the record's type writes none. Null when the type writes one. */
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

/** One toast for Looks right, on the thread, in AI picks and in Actions. */
export const LOOKS_RIGHT_DONE = "Marked as looked at.";

/** What the reply panel says when no draft is open, read from the record behind the thread. */
export function draftState(
  detail: {
    record: { groupKey: string | null; replyTypeName: string | null; replyTypeRules: Pick<TypeRules, "replyDraft"> | null; draftJobPending: boolean };
    replyTypePicks: readonly PickFacts[];
    policy: { doNotContact: boolean } | null;
    suppressed: boolean;
  },
  channel: string,
): { noDraft: string | null; drafting: boolean; decisionWaiting: boolean } {
  return {
    noDraft: noDraftReason({ name: detail.record.replyTypeName, rules: detail.record.replyTypeRules }),
    drafting: detail.record.draftJobPending,
    decisionWaiting: typeDecision(latestPick(detail.replyTypePicks), { doNotContact: detail.policy?.doNotContact === true, suppressed: detail.suppressed, channel }, detail.record) !== null,
  };
}
