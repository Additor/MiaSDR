// Pure rules for putting a removed lead back into its campaign. No I/O.

type Channel = "email" | "linkedin";

export type RestoreRefusal = "not_removed" | "campaign_closed" | "replied" | "do_not_contact" | "suppressed" | "contact" | "active_elsewhere" | "nothing_left";

export const RESTORE_REFUSAL_TEXT: Record<RestoreRefusal, string> = {
  not_removed: "Only a removed lead can be restored.",
  campaign_closed: "The campaign is completed or archived. Restore the lead to a campaign that is still open.",
  replied: "The person has replied, so no automated message goes to them.",
  do_not_contact: "The person is marked do not contact.",
  suppressed: "The email address is on the suppression list.",
  contact: "The person is a contact, so no campaign enrolls them.",
  active_elsewhere: "The person is already in another active campaign on this channel.",
  nothing_left: "Every step of the campaign was already sent, so nothing is left to send.",
};

export interface RestoreFacts {
  status: string;
  channel: Channel;
  /** Steps already completed (step 1 is the invitation on LinkedIn). The caller reconciles this with the sends rows first (see `restoredProgress`). */
  currentStep: number;
  totalSteps: number;
  /** LinkedIn only. */
  connectionState: "none" | "request_sent" | "connected" | null;
  campaignStatus: string;
  campaignArchived: boolean;
  /** A genuine reply from the person exists on any channel, or one of their enrollments ended as replied. */
  replied: boolean;
  doNotContact: boolean;
  /** Email only. LinkedIn has no suppression list. */
  suppressed: boolean;
  /** The person became a contact (`people.lifecycle`). A contact is never enrolled again. */
  contact: boolean;
  /** Name of another campaign where the person is pending or active on this channel. */
  activeElsewhere: string | null;
  /** When the last completed step went out; for a connected LinkedIn lead after the invitation, when the invitation was accepted. */
  lastSentAt?: Date | null;
  /** `waitDays` of the step that comes next, counted from `lastSentAt`. */
  nextWaitDays?: number;
}

const DAY_MS = 86_400_000;

/**
 * The progress a removed lead really has. `current_step` stops moving while a lead is removed, but a send in flight at removal
 * still completes and an acceptance still arrives. The sends rows (`sent` or `unknown`, never retried) and the connection state
 * are the record of what happened, so the larger of the three wins.
 */
export function restoredProgress(input: { channel: Channel; currentStep: number; lastSentStep: number; connectionState: "none" | "request_sent" | "connected" | null }): number {
  const fromConnection = input.channel === "linkedin" && input.connectionState !== null && input.connectionState !== "none" ? 1 : 0;
  return Math.max(input.currentStep, input.lastSentStep, fromConnection);
}

export type RestoreDecision = { ok: true; status: "pending" | "active"; nextSendAt: Date | null } | { ok: false; reason: RestoreRefusal };

/** The next step waits its own `waitDays` after the last send, so a lead restored soon after a send does not get the next step at once. */
function dueAt(facts: RestoreFacts, now: Date): Date {
  if (!facts.lastSentAt || !facts.nextWaitDays) return now;
  return new Date(Math.max(now.getTime(), facts.lastSentAt.getTime() + facts.nextWaitDays * DAY_MS));
}

/**
 * A lead that never sent anything goes back to `pending`. A lead with progress goes back to `active`, because the claims only
 * pick `pending` leads at step 0 and `active` leads with a due time: a `pending` lead with progress would wait forever.
 */
export function decideRestore(facts: RestoreFacts, now: Date): RestoreDecision {
  if (facts.status !== "removed") return { ok: false, reason: "not_removed" };
  if (facts.campaignStatus === "completed" || facts.campaignArchived) return { ok: false, reason: "campaign_closed" };
  if (facts.replied) return { ok: false, reason: "replied" };
  if (facts.doNotContact) return { ok: false, reason: "do_not_contact" };
  if (facts.suppressed) return { ok: false, reason: "suppressed" };
  if (facts.contact) return { ok: false, reason: "contact" };
  if (facts.activeElsewhere !== null) return { ok: false, reason: "active_elsewhere" };
  if (facts.currentStep === 0) return { ok: true, status: "pending", nextSendAt: null };

  const stepsLeft = facts.currentStep < facts.totalSteps;
  if (facts.channel === "linkedin") {
    // An invitation waiting for its answer needs no due time: the acceptance schedules the next step (or completes the lead).
    if (facts.connectionState !== "connected") return { ok: true, status: "active", nextSendAt: null };
    return stepsLeft ? { ok: true, status: "active", nextSendAt: dueAt(facts, now) } : { ok: false, reason: "nothing_left" };
  }
  return stepsLeft ? { ok: true, status: "active", nextSendAt: dueAt(facts, now) } : { ok: false, reason: "nothing_left" };
}
