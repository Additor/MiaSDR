import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { RESTORE_REFUSAL_TEXT, type RestoreRefusal } from "../domain/enrollment-restore";
import { MAX_PICKED_IDS, type OutreachChannel } from "./enrollment-admin";

export interface RestoreRefused {
  enrollmentId: string;
  personName: string | null;
  reason: RestoreRefusal;
  message: string;
  /** Set for `active_elsewhere`: the other campaign. */
  detail?: string;
}

export interface RestoreCounts {
  requested: number;
  restored: number;
  /** Per lead that stayed removed, with the reason. Unknown ids are in `notFound` and not listed here. */
  refused: RestoreRefused[];
  /** Unknown ids, ids of another campaign and ids of another organization; the three look the same. */
  notFound: number;
}

export interface RestoreInput {
  organizationId: string;
  campaignId: string;
  channel: OutreachChannel;
  enrollmentIds: string[];
  actorUserId: string;
  now: Date;
}

/** Persistence behind restore. */
export interface EnrollmentRestoreStore {
  /**
   * One transaction. Locks the named enrollments of the campaign, checks each against the person's current facts, and moves
   * every eligible `removed` row back to `pending` or `active`. Writes an `events` row and an `audit_log` row per restored lead.
   * Returns null when the campaign does not exist on this channel in this organization.
   */
  restore(input: RestoreInput): Promise<Omit<RestoreCounts, "requested"> | null>;
}

export interface EnrollmentRestoreDeps {
  restore: EnrollmentRestoreStore;
  now?: () => Date;
}

/**
 * Puts removed leads back into their campaign. A lead that replied, is on do not contact or the suppression list, is active in
 * another campaign on the channel, has no step left, or sits in a closed campaign stays removed and the answer says why.
 * Any member of the organization may restore, the same people who may remove.
 */
export async function restoreCampaignEnrollments(deps: EnrollmentRestoreDeps, actor: Actor, channel: OutreachChannel, campaignId: string, enrollmentIds: string[]): Promise<RestoreCounts> {
  const ids = [...new Set(enrollmentIds)];
  if (ids.length === 0) throw new ValidationError("Pick at least one lead to restore.");
  if (ids.length > MAX_PICKED_IDS) throw new ValidationError(`Restore up to ${MAX_PICKED_IDS} leads at a time.`);
  const result = await deps.restore.restore({ organizationId: actor.organizationId, campaignId, channel, enrollmentIds: ids, actorUserId: actor.userId, now: (deps.now ?? (() => new Date()))() });
  if (!result) throw new NotFoundError("Campaign not found");
  return { requested: ids.length, ...result };
}

export { RESTORE_REFUSAL_TEXT };
