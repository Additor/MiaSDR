/*
 * Lead status inside one campaign. The campaign's Leads tab shows each enrollment in the lead status vocabulary (Queued,
 * In sequence, Paused, Replied, Finished, Stopped) by running `leadStatus()` on that one enrollment and the campaign's
 * status, so a row on the campaign page and the lead's own token follow the same rules. A removed enrollment has no state.
 */
import { ENROLLMENT_STATUSES } from "./enrollment-status";
import { leadStatus, type LeadState, type LeadStatus } from "./lead-status";

/** One enrollment row of a campaign's lead table. */
export interface CampaignLeadFact {
  id: string;
  /** The enrollment status (`enrollments_status_ck`). */
  status: string;
  currentStep: number;
  lastSentAt: Date | null;
  nextSendAt: Date | null;
  stopReason: string | null;
}

/** The campaign the enrollment belongs to: its status (draft, active, paused or completed) and its name. */
export interface CampaignLeadScope {
  status: string;
  name: string;
}

/**
 * The lead status of one enrollment in its campaign, or null for a removed one. The rules of `leadStatus()` apply to this
 * enrollment alone:
 *
 * 1. replied: the enrollment is `replied` (an inbound reply in this campaign sets it while the lead is pending or active);
 * 2. in_sequence: `active` in an active campaign;
 * 3. paused: `active` or `pending` in a campaign that is not active (draft, paused or completed);
 * 4. queued: `pending` in an active campaign;
 * 5. finished: `completed`; stopped: `bounced`, `suppressed`, `failed` or `cancelled`;
 * 6. removed, or a status the schema does not know: no state.
 *
 * The hover facts (step, last and next send, stop reason) come from the enrollment. `otherCampaigns` stays 0: the page
 * is about this campaign.
 */
export function campaignLeadStatus(enrollment: CampaignLeadFact, campaign: CampaignLeadScope): LeadStatus | null {
  const status = leadStatus({
    enrollments: [{ ...enrollment, campaignStatus: campaign.status, campaignName: campaign.name, updatedAt: new Date(0) }],
    lastOutboundAt: null,
    hasInbound: false,
  });
  return status.state === "new" ? null : { ...status, otherCampaigns: 0 };
}

/** The state alone, for an enrollment status and a campaign status. The lead table's filters read it. */
export function campaignLeadState(status: string, campaignStatus: string): LeadState | null {
  return campaignLeadStatus({ id: "", status, currentStep: 0, lastSentAt: null, nextSendAt: null, stopReason: null }, { status: campaignStatus, name: "" })?.state ?? null;
}

/** The enrollment statuses that read as `state` in a campaign with this status. */
export function enrollmentStatusesFor(state: LeadState, campaignStatus: string): string[] {
  return ENROLLMENT_STATUSES.filter((status) => campaignLeadState(status, campaignStatus) === state);
}
