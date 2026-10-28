import { SUPPRESSION_REASONS } from "@/contexts/people/domain/reachability";

/** Enrollment statuses. Mirrors the `enrollments_status_ck` check in the schema. */
export const ENROLLMENT_STATUSES = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** An enrollment still in its sequence: waiting for the first step, or between steps. Every other status is an outcome. */
export const LIVE_ENROLLMENT_STATUSES = ["pending", "active"] as const satisfies readonly EnrollmentStatus[];

/**
 * Allowed status transitions of a `campaign_enrollments` row. A live enrollment moves to an outcome (a reply,
 * bounce, suppression, completion, failure, cancellation or removal) and outcomes are final, except that a person can
 * restore a removed lead to where it was. Every UPDATE of `campaign_enrollments.status` filters on
 * `ENROLLMENT_FROM[target]` or a subset of it, so a late writer never overwrites an outcome:
 * - an outcome goes through `endEnrollmentsTx` (`infrastructure/enrollment-end.ts`), which filters on this table;
 * - a send that advances a live enrollment, or completes it with its last step, filters on `LIVE_ENROLLMENT_STATUSES`;
 * - a restore moves `removed` back to `pending` or `active` and filters on `removed`.
 */
const LIVE: readonly EnrollmentStatus[] = LIVE_ENROLLMENT_STATUSES;
export const ENROLLMENT_FROM: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  pending: ["removed"],
  active: [...LIVE, "removed"],
  replied: LIVE,
  completed: LIVE,
  bounced: LIVE,
  suppressed: LIVE,
  failed: LIVE,
  cancelled: LIVE,
  removed: LIVE,
};

export const canMoveEnrollment = (from: EnrollmentStatus, to: EnrollmentStatus): boolean => ENROLLMENT_FROM[to].includes(from);

/** The statuses an enrollment ends in. */
export type EnrollmentOutcomeStatus = Exclude<EnrollmentStatus, (typeof LIVE_ENROLLMENT_STATUSES)[number]>;

/** How an enrollment ended: the status and the `stop_reason` stored with it. */
export interface EnrollmentOutcome {
  status: EnrollmentOutcomeStatus;
  reason: string;
}

/**
 * Why outreach to a person, or to an address, stops on every campaign at once. The token is the stored `stop_reason`.
 * The suppression reasons (`bounced`, `unsubscribed`, `complaint`, `manual`) are the reasons of `suppression_list`.
 * Conversations ends the person's follow-up runs for the same halt and keeps its own run reason for it.
 */
export const OUTREACH_HALTS = ["replied", ...SUPPRESSION_REASONS, "do_not_contact", "converted"] as const;
export type OutreachHalt = (typeof OUTREACH_HALTS)[number];

const HALT_STATUS: Record<OutreachHalt, EnrollmentOutcomeStatus> = {
  replied: "replied",
  bounced: "bounced",
  unsubscribed: "suppressed",
  complaint: "suppressed",
  manual: "suppressed",
  do_not_contact: "suppressed",
  converted: "cancelled",
};

export const haltOutcome = (halt: OutreachHalt): EnrollmentOutcome => ({ status: HALT_STATUS[halt], reason: halt });

/** A step that could not go out after its last attempt. The provider's message rides along in the reason, bounded. */
export const failedOutcome = (kind: "send_failed" | "profile_lookup_failed", error: string): EnrollmentOutcome => ({ status: "failed", reason: `${kind}: ${error}`.slice(0, 500) });

/** `removed` is terminal: a person took the lead out of the campaign. History stays, the person is untouched. */
export const REMOVED_STATUS: EnrollmentStatus = "removed";

/** Only a live lead can be removed. An outcome keeps its own history, so remove leaves it as it is. */
export const REMOVABLE_STATUSES = LIVE_ENROLLMENT_STATUSES;

export const canRemoveEnrollment = (status: string): boolean => (REMOVABLE_STATUSES as readonly string[]).includes(status);
