/*
 * Lead status: where a lead stands in outreach. It belongs to leads only; a contact carries no status, and reachability
 * (do not contact, a suppressed address) is a separate state (`reachability.ts`). The read model
 * (`infrastructure/drizzle-lead-statuses.ts`) fills it for a page of person ids, and the lead list and the lead page both
 * read it there, so the two always agree.
 *
 * new -> queued -> in_sequence <-> paused -> replied, or the sequence ends as finished (every step went out, no reply)
 * or stopped (cut short by a bounce, a suppression, a failure or a cancellation).
 */

export const LEAD_STATES = ["new", "queued", "in_sequence", "paused", "replied", "finished", "stopped"] as const;
export type LeadState = (typeof LEAD_STATES)[number];

export const LEAD_STATE_LABELS: Record<LeadState, string> = {
  new: "New",
  queued: "Queued",
  in_sequence: "In sequence",
  paused: "Paused",
  replied: "Replied",
  finished: "Finished",
  stopped: "Stopped",
};

/** One enrollment of the lead in a regular campaign, as the read model loads it. */
export interface LeadEnrollmentFact {
  id: string;
  /** The enrollment status (`enrollments_status_ck`). */
  status: string;
  /** The campaign status: draft, active, paused or completed. */
  campaignStatus: string;
  campaignName: string;
  updatedAt: Date;
  /** When the enrollment's latest step went out. Campaign sends live in `sends`, not `messages`. */
  lastSentAt: Date | null;
  nextSendAt: Date | null;
  currentStep: number;
  stopReason: string | null;
}

/** The enrollment that decided the state, with what the hover shows. */
export interface LeadStatusEnrollment {
  id: string;
  campaignName: string;
  step: number;
  lastSentAt: Date | null;
  nextSendAt: Date | null;
  stopReason: string | null;
}

export interface LeadStatus {
  state: LeadState;
  /** Null for a new lead, and for a reply that came in outside any campaign. */
  enrollment: LeadStatusEnrollment | null;
  /** Other regular campaigns the lead is in, removed ones left out. */
  otherCampaigns: number;
  /** The latest outbound message or campaign step, or null when nothing went out. */
  lastContactAt: Date | null;
}

export const NEW_LEAD_STATUS: LeadStatus = { state: "new", enrollment: null, otherCampaigns: 0, lastContactAt: null };

/**
 * The read the leads context depends on. One call covers a whole page of person ids in a fixed number of queries, scoped
 * to the organization. A person outreach knows nothing about has no entry, so callers fall back to `NEW_LEAD_STATUS`.
 */
export type ReadLeadStatuses = (organizationId: string, personIds: readonly string[]) => Promise<Map<string, LeadStatus>>;

const STOPPED = new Set(["bounced", "suppressed", "failed", "cancelled"]);

/** Newest `updatedAt` first, then the higher id, so the pick does not flip between renders. */
function newest(facts: readonly LeadEnrollmentFact[]): LeadEnrollmentFact | null {
  return [...facts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * Last contact is the latest outbound message (a human reply or a conversation message) or the latest campaign step of
 * any enrollment, removed ones included: a step that went out stays contact.
 */
export function latestContact(messageAt: Date | null, facts: readonly Pick<LeadEnrollmentFact, "lastSentAt">[]): Date | null {
  let latest = messageAt;
  for (const f of facts) if (f.lastSentAt && (!latest || f.lastSentAt > latest)) latest = f.lastSentAt;
  return latest;
}

/** A `pending` or `active` enrollment of a campaign that is not active (paused, or still a draft) sends nothing until the campaign runs. */
export const heldByCampaign = (status: string, campaignStatus: string): boolean => (status === "active" || status === "pending") && campaignStatus !== "active";

/**
 * The lead's status from its enrollments in regular campaigns, its latest outbound message and whether it wrote in a
 * public conversation. The first rule that matches wins:
 *
 * 1. replied: an inbound message, or an enrollment with status `replied` (a reply stops outreach to the lead);
 * 2. in_sequence: an `active` enrollment in an active campaign;
 * 3. paused: an `active` or `pending` enrollment in a campaign that is not active;
 * 4. queued: a `pending` enrollment in an active campaign;
 * 5. finished or stopped: the newest ended enrollment is `completed`, or bounced, suppressed, failed or cancelled;
 * 6. new: no enrollment, or removed ones only.
 *
 * Removed enrollments never count. Within a rule the newest enrollment decides.
 */
export function leadStatus(input: { enrollments: readonly LeadEnrollmentFact[]; lastOutboundAt: Date | null; hasInbound: boolean }): LeadStatus {
  const live = input.enrollments.filter((e) => e.status !== "removed");
  const lastContactAt = latestContact(input.lastOutboundAt, input.enrollments);
  const result = (state: LeadState, pick: LeadEnrollmentFact | null): LeadStatus => ({
    state,
    enrollment: pick && {
      id: pick.id,
      campaignName: pick.campaignName,
      step: pick.currentStep,
      lastSentAt: pick.lastSentAt,
      nextSendAt: pick.nextSendAt,
      stopReason: pick.stopReason,
    },
    otherCampaigns: pick ? live.length - 1 : live.length,
    lastContactAt,
  });

  const replied = newest(live.filter((e) => e.status === "replied"));
  if (replied || input.hasInbound) return result("replied", replied);

  const running = live.filter((e) => e.status === "active" || e.status === "pending");
  const campaignActive = (e: LeadEnrollmentFact) => e.campaignStatus === "active";
  const sending = newest(running.filter((e) => e.status === "active" && campaignActive(e)));
  if (sending) return result("in_sequence", sending);
  const paused = newest(running.filter((e) => heldByCampaign(e.status, e.campaignStatus)));
  if (paused) return result("paused", paused);
  const queued = newest(running.filter((e) => e.status === "pending" && campaignActive(e)));
  if (queued) return result("queued", queued);

  const ended = newest(live.filter((e) => e.status === "completed" || STOPPED.has(e.status)));
  if (ended) return result(ended.status === "completed" ? "finished" : "stopped", ended);

  return result("new", null);
}
