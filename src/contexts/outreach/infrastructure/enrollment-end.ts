import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { campaignEnrollments, people } from "@/platform/db/schema";
import { ENROLLMENT_FROM, haltOutcome, type EnrollmentOutcome, type OutreachHalt } from "../domain/enrollment-status";

export interface EndedEnrollment {
  id: string;
  personId: string;
  channel: string;
}

/**
 * The one writer of an enrollment outcome. It ends the enrollments `scope` selects that may still move to the outcome
 * (`ENROLLMENT_FROM`), clears the next send and stamps `updated_at`, so a late writer never overwrites an outcome that
 * landed first. Returns the rows it moved.
 */
export async function endEnrollmentsTx(tx: DbHandle, scope: SQL | undefined, outcome: EnrollmentOutcome, now: Date): Promise<EndedEnrollment[]> {
  return tx
    .update(campaignEnrollments)
    .set({ status: outcome.status, stopReason: outcome.reason, nextSendAt: null, updatedAt: now })
    .where(and(scope, inArray(campaignEnrollments.status, [...ENROLLMENT_FROM[outcome.status]])))
    .returning({ id: campaignEnrollments.id, personId: campaignEnrollments.personId, channel: campaignEnrollments.channel });
}

/**
 * Ends every live enrollment of these people, on every channel and campaign, for one halt. `stopContactTx` calls it inside
 * the transaction that records the trigger (a reply, do not contact) and records the event itself.
 */
export async function haltPersonEnrollmentsTx(tx: DbHandle, organizationId: string, personIds: readonly string[], halt: OutreachHalt, now: Date) {
  if (personIds.length === 0) return [];
  return endEnrollmentsTx(tx, and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, [...personIds])), haltOutcome(halt), now);
}

/** Ends the live email enrollments of every person in the organization with this stored address. LinkedIn stays open. */
export async function haltAddressEmailEnrollmentsTx(tx: DbHandle, organizationId: string, email: string, halt: OutreachHalt, now: Date) {
  const owners = tx.select({ id: people.id }).from(people).where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${email}`));
  return endEnrollmentsTx(tx, and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.channel, "email"), inArray(campaignEnrollments.personId, owners)), haltOutcome(halt), now);
}
