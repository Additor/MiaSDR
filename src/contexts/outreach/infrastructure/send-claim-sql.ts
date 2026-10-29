import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbHandle, DbTx } from "@/platform/db/client";
import { campaignEnrollments, sends } from "@/platform/db/schema";
import { sqlValues } from "@/platform/db/sql-values";
import { failedOutcome, LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";
import { SEND_COUNTED, SEND_FROM, SEND_FROM_CALL, type SendStatus } from "../domain/send-status";
import { endEnrollmentsTx } from "./enrollment-end";

/**
 * The claim rules the email and LinkedIn send engines share. The enrollment owns the attempt cap: `scheduleRetry`
 * ends it at the cap, and a claim picks only live enrollments, so no claim query compares an attempt number.
 * `sends.attempt` counts the claims that set out to call the provider. A check that stops a claim before the call
 * gives its attempt back; a crash before the call still counts it, so the cap also bounds a crash that repeats.
 */

/** A store or reconciler moving a send to `to`, from the statuses `SEND_FROM` allows. */
export const canSend = (to: SendStatus) => inArray(sends.status, [...SEND_FROM[to]]);

/** The claiming worker settling its own claim: a later attempt on the same row belongs to another worker. */
export const ownClaim = (claim: { sendId: string; attempt: number }) =>
  and(eq(sends.id, claim.sendId), inArray(sends.status, [...SEND_FROM_CALL]), eq(sends.attempt, claim.attempt));

/**
 * A reconciler or a person settling the row it read earlier: the same attempt, still in a status that may move to `to`.
 * A later claim of the same step has a higher attempt, so a stale result matches nothing and changes nothing.
 */
export const readAttempt = (send: { sendId: string; attempt: number }, to: SendStatus) =>
  and(eq(sends.id, send.sendId), eq(sends.attempt, send.attempt), canSend(to));

/** Raw SQL over enrollments aliased `e`: the step already has a send in flight, unresolved or sent. A failed one may go again. */
export const stepTaken = (stepNumber: SQL) =>
  sql`exists (select 1 from sends s where s.enrollment_id = e.id and s.step_number = ${stepNumber} and s.status in ${sqlValues(SEND_COUNTED)})`;

/** The ON CONFLICT condition of a claim insert: only a failed send goes back to `sending`, as the next attempt (the sends trigger holds the +1). */
export const reclaimGuard = sql`sends.status = 'failed'`;

/** Settles the worker's own claim as failed without counting it: nothing reached the provider. */
export async function giveBackAttempt(tx: DbHandle, claim: { sendId: string; attempt: number }, error: string) {
  return tx
    .update(sends)
    .set({ status: "failed", attempt: sql`greatest(${sends.attempt} - 1, 0)`, error })
    .where(ownClaim(claim))
    .returning({ id: sends.id });
}

/**
 * After a failed attempt: end the enrollment at the cap or on a fatal error, else wait `retryAfterMinutes` before the
 * next claim. The one place that compares an attempt with the cap.
 */
export async function scheduleRetry(
  tx: DbTx,
  enrollmentId: string,
  attempt: number,
  now: Date,
  retryAfterMinutes: number,
  maxAttempts: number,
  error: string,
  fatal = false,
) {
  if (fatal || attempt >= maxAttempts) {
    await endEnrollmentsTx(tx, eq(campaignEnrollments.id, enrollmentId), failedOutcome("send_failed", error), now);
    return;
  }
  await tx
    .update(campaignEnrollments)
    .set({ nextSendAt: new Date(now.getTime() + retryAfterMinutes * 60_000), updatedAt: now })
    .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
}
