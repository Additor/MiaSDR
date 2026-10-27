import type { FollowUpsRule, SystemRole } from "../../domain/reply-type";
import { AFTER_REPLY_OFF, followUpsContinue, startPosition, type InterruptReason, type RunStatus } from "./sequences";

export { AFTER_REPLY_OFF };

/**
 * Pure rules and wording for a campaign's "After a reply" setting. A campaign either hands a classified reply to the
 * Inbox (`handoff`) or lets the AI draft timed follow-ups that a person approves (`ai_drafts`). The mode is not stored
 * in a column: `ai_drafts` is a campaign-owned sequence that is active and has a published version, `handoff` is no
 * sequence or an archived one. Nothing here reads data, and nothing here can send.
 */

export type AfterReplyMode = "handoff" | "ai_drafts";
export const AFTER_REPLY_MODES: readonly AfterReplyMode[] = ["handoff", "ai_drafts"];
export const DEFAULT_AFTER_REPLY_MODE: AfterReplyMode = "handoff";

export const AFTER_REPLY_MODE_LABELS: Record<AfterReplyMode, string> = {
  handoff: "Off, hand to the Inbox",
  ai_drafts: "AI drafts, you approve",
};

export const isAfterReplyMode = (value: unknown): value is AfterReplyMode => value === "handoff" || value === "ai_drafts";

/** The mode a campaign is in, from the state of its After a reply sequence (null when it has none). */
export function afterReplyModeOf(flow: { status: string; hasPublishedVersion: boolean } | null): AfterReplyMode {
  return flow !== null && flow.status === "active" && flow.hasPublishedVersion ? "ai_drafts" : "handoff";
}

/** Name of the sequence a campaign owns for this setting. */
export const afterReplyFlowName = (campaignName: string): string => `${campaignName.trim()} (after a reply)`;

/** Why a campaign cannot draft follow-ups, or null when it can. */
export function afterReplyLockedReason(campaign: { channel: string; type: string }): string | null {
  if (campaign.type === "personal") return "Personal campaigns keep replies out of the Inbox, so they cannot draft follow-ups.";
  if (campaign.channel !== "email") return "Follow-up drafts are available for email campaigns only. Replies on LinkedIn go to the Inbox.";
  return null;
}

// New replies only -----------------------------------------------------------------------------------------

/**
 * Margin for the recency rule. A flow starts runs only for replies received at or after the moment it was turned on,
 * minus this margin, so a reply that arrived minutes before the save and is classified right after still starts. A
 * reply older than the margin never starts a run on its own: turning the setting on does not reach back into history.
 */
export const NEW_REPLY_MARGIN_MINUTES = 10;

// Why a run cannot start -----------------------------------------------------------------------------------

/** The facts that decide whether a run can start for a record, in the shape the use case loads them. */
export interface StartBlockFacts {
  record: {
    replyTypeId: string | null;
    groupKey: string | null;
    replyTypeKey: string | null;
    replyTypeName: string | null;
    /** The Follow-ups rule of the record's reply type, or null without a type. */
    followUps: FollowUpsRule | null;
    /** The Reply draft rule of the record's reply type: false for Don't write, which skips step 1. Null without a type. */
    replyDraft?: boolean | null;
    latestInboundMessageId: string | null;
    lastInboundAt: Date | null;
    workflowState: string;
    hasEmail: boolean;
  };
  conversation: { channel: string } | null;
  doNotContact: boolean;
  /** The person's address is on the suppression list. */
  suppressed: boolean;
  /** The person is a contact (`people.lifecycle`), who starts no follow-ups. */
  contact: boolean;
  /** The campaign that most recently emailed the person, or null. */
  owner: { name: string; channel: string; type: string; status: string; archived: boolean } | null;
  /** The owner's After a reply sequence, or null when it has none. */
  flow: { status: string; hasPublished: boolean } | null;
  stepCount: number;
  /** A person already answered the reply by hand. */
  answered: boolean;
  skipReply?: boolean;
}

/**
 * The first reason no run can start for this record, worded for the person who pressed Restart, or null when a run
 * can start. The checks follow what the engine requires: an email reply, an owning campaign that is running and has
 * AI drafts turned on with published steps, and a record the stop rules would not end at once.
 */
export function startBlockedReason(f: StartBlockFacts): string | null {
  const { record, owner, flow } = f;
  if (f.contact) return "The person is a contact, so follow-ups do not apply.";
  if (!record.latestInboundMessageId || !record.lastInboundAt || !f.conversation || f.conversation.channel !== "email") return "This conversation has no email reply to follow up on.";
  if (!owner) return "No campaign has emailed this person, so no follow-ups apply.";
  const locked = afterReplyLockedReason(owner);
  if (locked) return locked;
  if (owner.archived) return `The campaign ${owner.name} is archived, so it starts no new follow-ups.`;
  if (owner.status === "paused") return `The campaign ${owner.name} is paused. Resume it to restart follow-ups.`;
  if (owner.status === "draft") return `The campaign ${owner.name} has not started yet. Start it to run follow-ups.`;
  if (!flow || flow.status !== "active") return `AI drafts are off for the campaign ${owner.name}. Turn them on in its After a reply setting.`;
  if (!flow.hasPublished) return `The campaign ${owner.name} has no published follow-up steps. Add them in its After a reply setting.`;
  if (record.workflowState === "closed") return "Reply handling is closed, so follow-ups do not apply.";
  if (f.doNotContact) return "This person is marked do not contact, so follow-ups do not apply.";
  if (f.suppressed) return "This address is on the suppression list, so follow-ups do not apply.";
  if (!record.hasEmail) return "This person has no email address, so follow-ups cannot start.";
  if (!record.replyTypeId) return "The reply has no reply type yet, so follow-ups cannot start.";
  if (!followUpsContinue(record.followUps)) return followUpsStopReason(record.replyTypeName ?? record.replyTypeKey ?? "This reply type");
  if (startPosition({ stepCount: f.stepCount, answered: f.answered, skipReply: f.skipReply, replyDraft: record.replyDraft }) === null) {
    if (record.replyDraft === false && !f.answered && !f.skipReply) return replyDraftSkipReason(record.replyTypeName ?? record.replyTypeKey ?? "This reply type");
    return "A person already answered, and the flow has no follow-up step after the reply.";
  }
  return null;
}

// Run status, as a person reads it -----------------------------------------------------------------------

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  active: "Running",
  paused: "Paused",
  interrupted: "Stopped",
  completed: "Finished",
  cancelled: "Cancelled",
};

export const runStatusLabel = (status: RunStatus): string => RUN_STATUS_LABELS[status];

/** `sequence_runs.started_by`. */
export type RunStartedBy = "ai_assignment" | "human_override";

export const STARTED_BY_LABELS: Record<RunStartedBy, string> = {
  ai_assignment: "Automatic",
  human_override: "Restarted by a person",
};

export const startedByLabel = (startedBy: RunStartedBy): string => STARTED_BY_LABELS[startedBy];

// Why a run ended ----------------------------------------------------------------------------------------

/** Reasons the engine writes when the facts about a lead stop a run. */
export type StopReason = InterruptReason | typeof AFTER_REPLY_OFF;

export const INTERRUPT_REASON_LABELS: Record<StopReason, string> = {
  reply: "The person replied",
  do_not_contact: "The person was marked do not contact",
  unsubscribed: "The person unsubscribed",
  bounce: "The email address bounced",
  suppressed: "The address is on the suppression list",
  terminal_stage: "The reply moved to a reply type that stops follow-ups",
  record_closed: "A person closed reply handling",
  converted: "The person became a contact",
  [AFTER_REPLY_OFF]: "Follow-ups turned off for this campaign",
};

/**
 * Reasons that other code paths store on a run that a person or a write ended. They are not InterruptReason values,
 * but they appear in run history next to the ones above.
 */
export const OTHER_END_REASON_LABELS: Record<string, string> = {
  manual: "A person cancelled the follow-ups",
  replaced: "A person started a different flow",
  stage_moved: "A person changed the reply type",
  classification_corrected: "A person corrected the AI pick",
  classification_undone: "A person undid the AI pick",
};

/** Wording for any reason stored on a run. An unknown reason reads as a plain stop. */
export function stopReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Stopped";
  if (Object.hasOwn(INTERRUPT_REASON_LABELS, reason)) return INTERRUPT_REASON_LABELS[reason as StopReason];
  if (Object.hasOwn(OTHER_END_REASON_LABELS, reason)) return OTHER_END_REASON_LABELS[reason];
  return "Stopped";
}

// What always stops follow-ups ---------------------------------------------------------------------------

/** A fact about the person or the record that ends a run whatever the reply type's rules say. */
export interface FixedStopRule {
  id: string;
  /** One line for the read-only list in the campaign's After a reply settings. */
  label: string;
  /** The reason the engine stores when this fact ends a run. */
  reason: InterruptReason;
}

/** The fixed rules, in the order `interruptReason` checks them. The reply types that stop follow-ups are data: see `StopReplyType`. */
export const FIXED_STOP_RULES: readonly FixedStopRule[] = [
  { id: "reply", label: "The person replies again", reason: "reply" },
  { id: "do_not_contact", label: "The person is marked do not contact", reason: "do_not_contact" },
  { id: "unsubscribe", label: "The person unsubscribes", reason: "unsubscribed" },
  { id: "bounce", label: "The address bounces", reason: "bounce" },
  { id: "suppressed", label: "The address is on the suppression list", reason: "suppressed" },
  { id: "record_closed", label: "Reply handling is closed", reason: "record_closed" },
  { id: "converted", label: "The person becomes a contact", reason: "converted" },
];

/** Why no run starts on a one-step flow for a type set to Don't write a reply draft: step 1 is skipped, and nothing follows it. */
export const replyDraftSkipReason = (typeName: string): string => `${typeName} is set to not write a reply draft, and the flow has no follow-up step after the reply.`;

/** Why a reply type ends follow-ups, worded as the Restart button and the campaign settings show it. */
export const followUpsStopReason = (typeName: string): string => `${typeName} is set to stop follow-ups.`;

/** An active reply type of the organization whose Follow-ups rule is Stop. A move into it ends a running run, and no run starts on it. */
export interface StopReplyType {
  id: string;
  key: string;
  name: string;
  groupKey: string;
  systemRole: SystemRole | null;
  /** `followUpsStopReason` for this type. */
  reason: string;
}

/** One line per thing that ends follow-ups: the fixed rules, then each stop type by name. */
export function stopsOnLines(stopTypes: readonly Pick<StopReplyType, "id" | "name">[]): Array<{ id: string; label: string }> {
  return [...FIXED_STOP_RULES.map(({ id, label }) => ({ id, label })), ...stopTypes.map((t) => ({ id: `reply_type:${t.id}`, label: `The reply type is ${t.name}` }))];
}
