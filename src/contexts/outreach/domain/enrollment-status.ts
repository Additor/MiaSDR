/** Enrollment statuses. Mirrors the `enrollments_status_ck` check in the schema. */
export const ENROLLMENT_STATUSES = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** `removed` is terminal: a person took the lead out of the campaign. History stays, the person is untouched. */
export const REMOVED_STATUS: EnrollmentStatus = "removed";

/**
 * Only a lead still waiting or running can be removed. A reply, bounce, suppression, completion, failure or
 * cancellation is a final outcome with its own history, so remove leaves those statuses as they are.
 */
export const REMOVABLE_STATUSES = ["pending", "active"] as const satisfies readonly EnrollmentStatus[];

export const canRemoveEnrollment = (status: string): boolean => (REMOVABLE_STATUSES as readonly string[]).includes(status);
