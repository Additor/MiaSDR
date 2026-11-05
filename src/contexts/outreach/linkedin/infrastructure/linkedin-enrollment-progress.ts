import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { campaignEnrollments, linkedinEnrollmentDetails } from "@/platform/db/schema";
import { LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";
import { afterStep } from "../domain/linkedin";

type Tx = DbTx;

/** Applies the acceptance of one enrollment: connected, and the first message scheduled. Idempotent. Used by the engine and the inbound handler. */
export async function applyAcceptance(tx: Tx, enrollmentId: string, step2WaitDays: number | null, now: Date): Promise<boolean> {
  const changed = await tx
    .update(linkedinEnrollmentDetails)
    .set({ connectionState: "connected", acceptedAt: now })
    .where(and(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId), sql`${linkedinEnrollmentDetails.connectionState} <> 'connected'`))
    .returning({ id: linkedinEnrollmentDetails.enrollmentId });
  if (changed.length === 0) return false;
  await tx
    .update(campaignEnrollments)
    .set({
      ...afterStep(step2WaitDays, now),
      currentStep: sql`greatest(${campaignEnrollments.currentStep}, 1)`,
      updatedAt: now,
    })
    .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
  return true;
}

/** After a delivered message step: advance, or finish when it was the last one. Never moves backwards. */
export async function advanceAfterMessage(tx: Tx, enrollmentId: string, stepNumber: number, nextWaitDays: number | null, now: Date) {
  await tx
    .update(campaignEnrollments)
    .set({
      currentStep: stepNumber,
      lastSentAt: now,
      ...afterStep(nextWaitDays, now),
      updatedAt: now,
    })
    .where(and(eq(campaignEnrollments.id, enrollmentId), sql`${campaignEnrollments.currentStep} < ${stepNumber}`, inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
}

/** After an invitation went out. Does nothing to the enrollment when the acceptance arrived first. */
export async function advanceAfterInvitation(tx: Tx, enrollmentId: string, accountId: string, now: Date) {
  const moved = await tx
    .update(linkedinEnrollmentDetails)
    .set({ connectionState: "request_sent", requestSentAt: now })
    .where(and(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId), eq(linkedinEnrollmentDetails.connectionState, "none")))
    .returning({ id: linkedinEnrollmentDetails.enrollmentId });
  if (moved.length === 0) return;
  await tx
    .update(campaignEnrollments)
    .set({ status: "active", currentStep: 1, lastSentAt: now, nextSendAt: null, linkedinAccountId: accountId, updatedAt: now })
    .where(and(eq(campaignEnrollments.id, enrollmentId), sql`${campaignEnrollments.currentStep} < 1`, inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
}
