import { ValidationError } from "@/shared/errors";

/**
 * A reply type and its type rules, and the one function that reads them. Each type tells the AI what to do when it
 * picks that type: whether a person checks the pick (before it applies, after, or not at all), whether the AI writes a
 * reply draft, and whether follow-ups keep going. `decideReplyType` is the only interpreter of these rules; the AI
 * apply path, a person's type change and `typeChangeOutcome` all call it. Rules apply at decision time only, and each
 * pick stores a snapshot of the rules it used (`reply_type_picks.rules`).
 */

export const CHECK_MODES = ["before", "after", "skip"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

export const FOLLOW_UPS_RULES = ["continue", "stop"] as const;
export type FollowUpsRule = (typeof FOLLOW_UPS_RULES)[number];

/** A type with a system role drives a fixed path, so some of its rules and its archive state are fixed. */
export const SYSTEM_ROLES = ["stop_request", "customer"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export interface TypeRules {
  checkMode: CheckMode;
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

/** The rules a stop request type always has. `reply_types_stop_request_ck` holds the same values. */
export const STOP_REQUEST_RULES: Readonly<TypeRules> = { checkMode: "before", replyDraft: false, followUps: "stop" };

/** Rules of a type a person adds, until they choose others. */
export const DEFAULT_TYPE_RULES: Readonly<TypeRules> = { checkMode: "after", replyDraft: true, followUps: "continue" };

/** Why a system-role type cannot be archived and keeps the rules it has, worded for the settings screen. */
export const SYSTEM_ROLE_REASONS: Record<SystemRole, string> = {
  stop_request: "The AI's pick of this type always waits for a person. It writes no draft and stops follow-ups. Use Stop contacting to stop all outreach to the person.",
  customer: "A person moved into Existing customer is locked there, so the AI cannot move them to another group. This type keeps the group in use, so it cannot be archived.",
};

export const isCheckMode = (value: unknown): value is CheckMode => CHECK_MODES.includes(value as CheckMode);
export const isFollowUpsRule = (value: unknown): value is FollowUpsRule => FOLLOW_UPS_RULES.includes(value as FollowUpsRule);
export const isSystemRole = (value: unknown): value is SystemRole => SYSTEM_ROLES.includes(value as SystemRole);

/** The rules of a stored type, read from the `reply_types` columns. */
export const typeRulesOf = (row: { checkMode: string; replyDraft: boolean; followUps: string }): TypeRules => ({
  checkMode: isCheckMode(row.checkMode) ? row.checkMode : "before",
  replyDraft: row.replyDraft,
  followUps: isFollowUpsRule(row.followUps) ? row.followUps : "stop",
});

/**
 * Checks a set of rules for a type and returns them. A stop request type keeps `STOP_REQUEST_RULES`. A customer type
 * may take any rules; its lock and its archive state are fixed elsewhere.
 */
export function validateTypeRules(type: { systemRole: SystemRole | null }, rules: TypeRules): TypeRules {
  if (!isCheckMode(rules.checkMode)) throw new ValidationError("Check must be before, after or skip.");
  if (typeof rules.replyDraft !== "boolean") throw new ValidationError("Reply draft must be true or false.");
  if (!isFollowUpsRule(rules.followUps)) throw new ValidationError("Follow-ups must be continue or stop.");
  if (type.systemRole === "stop_request") {
    if (rules.checkMode !== STOP_REQUEST_RULES.checkMode) throw new ValidationError("A stop request is always checked before it applies.");
    if (rules.replyDraft !== STOP_REQUEST_RULES.replyDraft) throw new ValidationError("A stop request never gets a reply draft.");
    if (rules.followUps !== STOP_REQUEST_RULES.followUps) throw new ValidationError("A stop request always stops follow-ups.");
  }
  return { checkMode: rules.checkMode, replyDraft: rules.replyDraft, followUps: rules.followUps };
}

// Decision --------------------------------------------------------------------------------------------------

/** Why an AI pick waits for a person. The values are stored in `reply_type_picks.response.holdReason`. */
export const HOLD_REASONS = ["protected_customer", "requires_review", "low_confidence"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * A stored hold reason, read back. A reason stored before migration 0003 (`protected_stage`, `customer_requires_review`,
 * `review_other`) or any other value reads as null, so a reader shows its fallback.
 */
export const holdReasonOf = (value: unknown): HoldReason | null => (HOLD_REASONS.includes(value as HoldReason) ? (value as HoldReason) : null);

/**
 * After a reply mode of the campaign that owns the conversation, or null when no campaign does. A campaign that starts
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
  /** The organization's confidence floor (`reply_handling_settings.auto_apply_confidence`). */
  floor: number;
  /** The record is locked to its current group (`records.reply_type_locked`). */
  locked: boolean;
  /** The record's type before this pick, or null when it has none. Its group decides the customer lock hold. */
  currentType: { groupKey: string | null } | null;
}

export type FollowUpsOutcome = FollowUpsRule | "not_applicable";

export interface ReplyTypeDecision {
  /** An AI pick that waits for a person before it applies, and why. Null when it applies, and for a person's pick. */
  hold: HoldReason | null;
  /** An applied AI pick that a person should mark Looks right. */
  needsLooksRight: boolean;
  /** Once applied, the AI writes a reply draft. */
  wantsDraft: boolean;
  /** Once applied: follow-ups keep going or stop, or none apply to this conversation. */
  followUps: FollowUpsOutcome;
}

/**
 * What applying `type` means for one reply. The type's rules decide, inside fixed rules no setting changes: a
 * locked customer stays in its group until a person moves it, an AI pick below the floor waits for a person, a stop
 * request gets no draft and stops follow-ups, and follow-ups only apply to email conversations of a campaign in
 * `ai_drafts` mode whose person is not a contact.
 */
export function decideReplyType(type: Pick<ReplyType, "groupKey" | "rules">, facts: ReplyTypeFacts): ReplyTypeDecision {
  const ai = facts.confidence !== null;
  let hold: HoldReason | null = null;
  if (ai) {
    if (facts.locked && type.groupKey !== facts.currentType?.groupKey) hold = "protected_customer";
    else if (type.rules.checkMode === "before") hold = "requires_review";
    else if ((facts.confidence as number) < facts.floor) hold = "low_confidence";
  }
  const followUps: FollowUpsOutcome =
    facts.isContact || facts.campaignMode !== "ai_drafts" || facts.channel !== "email" ? "not_applicable" : facts.stopRequested ? "stop" : type.rules.followUps;
  return {
    hold,
    needsLooksRight: ai && hold === null && type.rules.checkMode === "after",
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
 * The two ways Change type moves a record. `correct` is a person's pick for the latest reply, which queues a draft when
 * the type writes one. `off_thread` changes the record's type for something that happened elsewhere and writes no draft.
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
