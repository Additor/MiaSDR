import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { campaignEnrollments, linkedinEnrollmentDetails } from "@/platform/db/schema";
import { ENROLLMENT_FROM, haltOutcome, LIVE_ENROLLMENT_STATUSES, type EnrollmentOutcome, type OutreachHalt } from "../domain/enrollment-status";

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
 * Ends the live enrollments of these people for one halt, in every campaign, on every channel or on email alone. Every
 * `stopContactTx` trigger ends enrollments here, inside the transaction that records the trigger.
 *
 * It locks in the order of the LinkedIn paths (acceptance, invitation sent): the details rows, then the enrollment rows, each
 * set in id order, so a webhook loop and this write stay out of each other's way. An ended LinkedIn enrollment loses its
 * resolve retry time, as removing one does. The status condition repeats in the write, so a writer that raced this one
 * keeps its outcome.
 */
export async function haltEnrollmentsTx(tx: DbHandle, input: { organizationId: string; personIds: readonly string[]; channels: "every_channel" | "email_only"; halt: OutreachHalt; now: Date }): Promise<EndedEnrollment[]> {
  const { organizationId, personIds, channels, halt, now } = input;
  if (personIds.length === 0) return [];
  const ofPeople = and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, [...personIds]), inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES]));
  if (channels === "every_channel") {
    const linkedin = await tx.select({ id: campaignEnrollments.id }).from(campaignEnrollments).where(and(ofPeople, eq(campaignEnrollments.channel, "linkedin")));
    if (linkedin.length > 0) {
      await tx
        .select({ id: linkedinEnrollmentDetails.enrollmentId })
        .from(linkedinEnrollmentDetails)
        .where(inArray(linkedinEnrollmentDetails.enrollmentId, linkedin.map((e) => e.id)))
        .orderBy(asc(linkedinEnrollmentDetails.enrollmentId))
        .for("update");
    }
  }
  const live = await tx
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(and(ofPeople, channels === "email_only" ? eq(campaignEnrollments.channel, "email") : undefined))
    .orderBy(asc(campaignEnrollments.id))
    .for("update");
  if (live.length === 0) return [];
  const ended = await endEnrollmentsTx(tx, and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.id, live.map((e) => e.id))), haltOutcome(halt), now);
  const endedLinkedin = ended.filter((e) => e.channel === "linkedin").map((e) => e.id);
  if (endedLinkedin.length > 0) await tx.update(linkedinEnrollmentDetails).set({ resolveNextAttemptAt: null }).where(inArray(linkedinEnrollmentDetails.enrollmentId, endedLinkedin));
  return ended;
}
