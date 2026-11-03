/**
 * A reply type and its type rules, and the one function that reads them. Each type tells the AI whether to write a reply
 * draft and whether follow-ups keep going. Whether an AI pick waits for a person is one fixed rule, the same for every
 * type (`decideReplyType`). A pick sends nothing: the draft approval is the gate for what goes out. `decideReplyType` is
 * the only interpreter of these rules; the AI apply path, a person's type change and `typeChangeOutcome` all call it.
 * Each pick stores a snapshot of the rules it used (`reply_type_picks.rules`).
 */

export const FOLLOW_UPS_RULES = ["continue", "stop"] as const;
export type FollowUpsRule = (typeof FOLLOW_UPS_RULES)[number];

/** A type with a system role drives a fixed path. */
export const SYSTEM_ROLES = ["stop_request", "customer"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export interface TypeRules {
  replyDraft: boolean;
  followUps: FollowUpsRule;
}

export interface ReplyType {
  id: string;
  key: string;
  name: string;
  groupKey: string;
  systemRole: SystemRole | null;
  rules: TypeRules;
}

/** An AI pick with a confidence under this waits for a person. */
export const AI_PICK_CONFIDENCE_FLOOR = 0.85;

/** What a system-role type does beyond its rules, worded for the settings screen. */
export const SYSTEM_ROLE_REASONS: Record<SystemRole, string> = {
  stop_request: "The AI's pick of this type always waits for a person. Use Stop contacting to stop all outreach to the person.",
  customer: "A person moved into Existing customer is locked there, so the AI's pick to another group waits for a person.",
};

export const isFollowUpsRule = (value: unknown): value is FollowUpsRule => FOLLOW_UPS_RULES.includes(value as FollowUpsRule);
export const isSystemRole = (value: unknown): value is SystemRole => SYSTEM_ROLES.includes(value as SystemRole);

/** The rules of a stored type, read from the `reply_types` columns. */
export const typeRulesOf = (row: { replyDraft: boolean; followUps: string }): TypeRules => ({
  replyDraft: row.replyDraft,
  followUps: isFollowUpsRule(row.followUps) ? row.followUps : "stop",
});

// Decision --------------------------------------------------------------------------------------------------

/** Why an AI pick waits for a person. The values are stored in `reply_type_picks.response.holdReason`. */
export const HOLD_REASONS = ["protected_customer", "stop_request", "low_confidence"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * A stored hold reason, read back. The column is JSON, so any other value reads as null and a reader shows its fallback.
 */
export const holdReasonOf = (value: unknown): HoldReason | null => (HOLD_REASONS.includes(value as HoldReason) ? (value as HoldReason) : null);

/**
 * Follow-ups after a reply mode of the campaign that owns the conversation, or null when no campaign does. A campaign that starts
 * no runs (`startableCampaignSql`) reads as its state instead: `paused`, `not_started` (a draft) or `archived`.
 */
export type CampaignMode = "handoff" | "ai_drafts" | "paused" | "not_started" | "archived" | null;

export interface ReplyTypeFacts {
  /** The reply's own words ask us to stop (`detectsStopRequest`), or the pick is a stop request type. */
  stopRequested: boolean;
  /** The person is a contact (`people.lifecycle`). */
  isContact: boolean;
  campaignMode: CampaignMode;
  /** Channel of the conversation the reply came in on. */
  channel: string | null;
  /** The AI's confidence. Null when a person picks the type. */
  confidence: number | null;
  /** The conversation is locked to its current group (`conversations.reply_type_locked`). */
  locked: boolean;
  /** The conversation's type before this pick, or null when it has none. Its group decides the customer lock hold. */
  currentType: { groupKey: string | null } | null;
}

export type FollowUpsOutcome = FollowUpsRule | "not_applicable";

export interface ReplyTypeDecision {
  /** An AI pick that waits for a person before it applies, and why. Null when it applies, and for a person's pick. */
  hold: HoldReason | null;
  /** Once applied, the AI writes a reply draft. */
  wantsDraft: boolean;
  /** Once applied: follow-ups keep going or stop, or none apply to this conversation. */
  followUps: FollowUpsOutcome;
}

/**
 * What applying `type` means for one reply. An AI pick waits for a person when the conversation is locked as Existing customer
 * and the pick moves it out, when it is the stop request type, or when its confidence is under
 * `AI_PICK_CONFIDENCE_FLOOR`. Every other AI pick applies at once, and a person corrects a wrong one with Change type or
 * Undo. A person's pick never waits. A stop request gets no draft and stops follow-ups, and follow-ups only apply to email
 * conversations of a campaign in `ai_drafts` mode whose person is not a contact.
 */
export function decideReplyType(type: Pick<ReplyType, "groupKey" | "rules" | "systemRole">, facts: ReplyTypeFacts): ReplyTypeDecision {
  let hold: HoldReason | null = null;
  if (facts.confidence !== null) {
    if (facts.locked && type.groupKey !== facts.currentType?.groupKey) hold = "protected_customer";
    else if (type.systemRole === "stop_request") hold = "stop_request";
    else if (facts.confidence < AI_PICK_CONFIDENCE_FLOOR) hold = "low_confidence";
  }
  const followUps: FollowUpsOutcome =
    facts.isContact || facts.campaignMode !== "ai_drafts" || facts.channel !== "email" ? "not_applicable" : facts.stopRequested ? "stop" : type.rules.followUps;
  return {
    hold,
    wantsDraft: type.rules.replyDraft && !facts.stopRequested,
    followUps,
  };
}

// Outcome of a person's type change -------------------------------------------------------------------------

export interface TypeChangeOutcome {
  replyDraft: string;
  followUps: string;
  contact: string;
}

/**
 * The two ways Change type moves a conversation. `correct` is a person's pick for the latest reply, which queues a draft when
 * the type writes one. `off_thread` changes the conversation's type for something that happened elsewhere and writes no draft.
 */
export const TYPE_CHANGE_PATHS = ["correct", "off_thread"] as const;
export type TypeChangePath = (typeof TYPE_CHANGE_PATHS)[number];
export const isTypeChangePath = (value: unknown): value is TypeChangePath => TYPE_CHANGE_PATHS.includes(value as TypeChangePath);

/**
 * Three lines for the Change type dialog, from the decision the change would get on `path`. A type change never marks
 * the person do not contact: only Stop contacting does.
 */
export function typeChangeOutcome(
  current: Pick<ReplyType, "name" | "groupKey" | "rules" | "systemRole"> | null,
  target: Pick<ReplyType, "name" | "groupKey" | "rules" | "systemRole">,
  facts: Omit<ReplyTypeFacts, "confidence">,
  path: TypeChangePath = "correct",
): TypeChangeOutcome {
  const decision = decideReplyType(target, { ...facts, confidence: null });
  const before = current ? decideReplyType(current, { ...facts, confidence: null }) : null;

  const replyDraft = decision.wantsDraft
    ? path === "correct"
      ? "Reply draft: the AI writes a new one."
      : "Reply draft: none written now. Write a draft from the reply when you need one."
    : facts.stopRequested
      ? "Reply draft: none, because they asked to stop."
      : `Reply draft: none. ${target.name} is set to not write one.`;

  const followUps =
    decision.followUps === "not_applicable"
      ? facts.isContact
        ? "Follow-ups: none, because the person is a contact."
        : facts.campaignMode === "paused"
          ? "Follow-ups: none while the campaign is paused."
          : facts.campaignMode === "not_started"
            ? "Follow-ups: none until the campaign starts."
            : facts.campaignMode === "archived"
              ? "Follow-ups: none, because the campaign is archived."
              : "Follow-ups: none for this conversation."
      : decision.followUps === "continue"
        ? "Follow-ups: keep going."
        : facts.stopRequested
          ? "Follow-ups: stop, because they asked to stop."
          : before?.followUps === "stop"
          ? "Follow-ups: stay stopped."
          : `Follow-ups: stop. ${target.name} is set to stop follow-ups.`;

  const contact = target.systemRole === "stop_request" ? "Contact: unchanged until you choose Stop contacting." : "Contact: unchanged.";
  return { replyDraft, followUps, contact };
}
