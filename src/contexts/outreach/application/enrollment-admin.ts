import type { DbHandle } from "@/platform/db/client";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";

export type OutreachChannel = "email" | "linkedin";

/** Most people one picked-lead enroll or one bulk remove may name. */
export const MAX_PICKED_IDS = 500;

/** Counts for an enroll of hand-picked people. Every requested id lands in exactly one bucket. */
export interface PickedEnrollCounts {
  requested: number;
  added: number;
  /** No email (email campaign) or no LinkedIn profile (LinkedIn campaign). */
  skippedMissingIdentity: number;
  /** Already enrolled and not removed. */
  skippedDuplicate: number;
  /** Removed earlier from this campaign. Enrolling does not bring it back; restore it (`restoreCampaignEnrollments`) instead. */
  skippedRemoved: number;
  /** On the suppression list. LinkedIn has no suppression list, so this stays 0 there. */
  skippedSuppressed: number;
  skippedDoNotContact: number;
  /** The person is a contact (a deal exists or was created from the lead), and a contact is not enrolled in campaigns. */
  skippedContact: number;
  /** Unknown ids and ids of another organization; the two look the same. */
  skippedNotFound: number;
}

export interface RemoveCounts {
  requested: number;
  removed: number;
  /** Already `removed`, so nothing changed. */
  alreadyRemoved: number;
  /** Replied, bounced, suppressed, completed, failed or cancelled: a final outcome that remove leaves alone. */
  skippedFinal: number;
  /** Unknown ids, ids of another campaign and ids of another organization; the three look the same. */
  notFound: number;
}

/** A mailbox or LinkedIn account a campaign can send from. */
export interface SenderRef {
  id: string;
  label: string;
  connected: boolean;
}

/** Hand-picked enrollment, enrollment removal and per-campaign senders, for both channels. */
export interface EnrollmentAdminStore {
  /** One transaction. Skips what cannot be enrolled and counts why. */
  enrollPicked(organizationId: string, campaignId: string, channel: OutreachChannel, personIds: string[], tx?: DbHandle): Promise<PickedEnrollCounts>;
  /**
   * One transaction: every named `pending` or `active` enrollment of this campaign becomes `removed`, stops being
   * due and keeps its history. The person and the sends are not touched.
   */
  removeEnrollments(organizationId: string, campaignId: string, channel: OutreachChannel, enrollmentIds: string[], now: Date): Promise<RemoveCounts>;
  /** The campaign's assigned senders. Empty means every connected sender of the organization may send. */
  listSenders(organizationId: string, campaignId: string, channel: OutreachChannel): Promise<SenderRef[]>;
  /** The senders of this organization among `ids`. Ids of another organization are left out. */
  findSenders(organizationId: string, channel: OutreachChannel, ids: string[]): Promise<SenderRef[]>;
  /** Every sender of the organization on this channel, for a picker. */
  listAvailableSenders(organizationId: string, channel: OutreachChannel): Promise<SenderRef[]>;
  /** Replaces the whole list. An empty list restores the default of sending from every connected sender. */
  replaceSenders(organizationId: string, campaignId: string, channel: OutreachChannel, ids: string[], tx?: DbHandle): Promise<void>;
}

/** The store from a deps object. Composition always sets it; a missing one is a wiring mistake, not a user error. */
export function adminStore(deps: { admin?: EnrollmentAdminStore }): EnrollmentAdminStore {
  if (!deps.admin) throw new Error("The enrollment admin store is not wired into these deps.");
  return deps.admin;
}

const NOUN: Record<OutreachChannel, string> = { email: "mailbox", linkedin: "LinkedIn account" };

/** Checks that each id is a sender of the organization and is connected. Returns the ids without duplicates. */
export async function validateSenderIds(admin: EnrollmentAdminStore, actor: Actor, channel: OutreachChannel, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Map((await admin.findSenders(actor.organizationId, channel, unique)).map((s) => [s.id, s]));
  if (unique.some((id) => !found.has(id))) throw new ValidationError(`Pick ${NOUN[channel]}s from this organization.`);
  const offline = unique.map((id) => found.get(id) as SenderRef).filter((s) => !s.connected);
  if (offline.length > 0) throw new ValidationError(`Reconnect or remove ${offline.map((s) => s.label).join(", ")} before assigning ${offline.length === 1 ? "it" : "them"}.`);
  return unique;
}

/** Launch check: with senders assigned, each one must be connected. No assigned senders means the default applies. */
export async function assertAssignedSendersConnected(admin: EnrollmentAdminStore, actor: Actor, channel: OutreachChannel, campaignId: string): Promise<void> {
  const offline = (await admin.listSenders(actor.organizationId, campaignId, channel)).filter((s) => !s.connected);
  if (offline.length > 0) {
    throw new ValidationError(`Every assigned ${NOUN[channel]} must be connected before starting. Reconnect or remove ${offline.map((s) => s.label).join(", ")}.`);
  }
}

export async function removeCampaignEnrollments(
  deps: { admin?: EnrollmentAdminStore; now?: () => Date },
  actor: Actor,
  channel: OutreachChannel,
  campaignId: string,
  enrollmentIds: string[],
): Promise<RemoveCounts> {
  const ids = [...new Set(enrollmentIds)];
  if (ids.length === 0) throw new ValidationError("Pick at least one lead to remove.");
  if (ids.length > MAX_PICKED_IDS) throw new ValidationError(`Remove up to ${MAX_PICKED_IDS} leads at a time.`);
  return adminStore(deps).removeEnrollments(actor.organizationId, campaignId, channel, ids, deps.now?.() ?? new Date());
}

/** Removes one enrollment. A repeat call changes nothing, and a lead with a final status keeps it. Unknown ids answer not found. */
export async function removeCampaignEnrollment(
  deps: { admin?: EnrollmentAdminStore; now?: () => Date },
  actor: Actor,
  channel: OutreachChannel,
  campaignId: string,
  enrollmentId: string,
): Promise<{ removed: boolean; skippedFinal: boolean }> {
  const result = await removeCampaignEnrollments(deps, actor, channel, campaignId, [enrollmentId]);
  if (result.notFound > 0) throw new NotFoundError("Lead not found in this campaign");
  return { removed: result.removed > 0, skippedFinal: result.skippedFinal > 0 };
}
