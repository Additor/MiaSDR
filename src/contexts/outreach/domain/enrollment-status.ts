/** Enrollment statuses. Mirrors the `enrollments_status_ck` check in the schema. */
export const ENROLLMENT_STATUSES = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** An enrollment still in its sequence: waiting for the first step, or between steps. Every other status is an outcome. */
export const LIVE_ENROLLMENT_STATUSES = ["pending", "active"] as const satisfies readonly EnrollmentStatus[];

/**
 * Allowed status transitions of a `campaign_enrollments` row. A live enrollment moves to an outcome (a reply,
 * bounce, suppression, completion, failure, cancellation or removal) and outcomes are final, except that a person can
 * restore a removed lead to where it was. Every UPDATE of `campaign_enrollments.status` filters on
 * `ENROLLMENT_FROM[target]` or a subset of it, so a late writer never overwrites an outcome.
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

/** `removed` is terminal: a person took the lead out of the campaign. History stays, the person is untouched. */
export const REMOVED_STATUS: EnrollmentStatus = "removed";

/** Only a live lead can be removed. An outcome keeps its own history, so remove leaves it as it is. */
export const REMOVABLE_STATUSES = LIVE_ENROLLMENT_STATUSES;

export const canRemoveEnrollment = (status: string): boolean => (REMOVABLE_STATUSES as readonly string[]).includes(status);
