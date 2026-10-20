/**
 * Rules for putting a failed AI job back in the queue.
 *
 * A job fails for one of four reasons, stored on the job as `payload.failureKind`:
 * - transient: the provider or network failed on every attempt. Waiting helps.
 * - lease: the worker died during the last attempt. Waiting helps.
 * - shape: the provider answered, but not in the requested form on every attempt. The prompt or model is the
 *   problem, so the sweep leaves it alone. A person can still requeue it after changing something.
 * - permanent: a rejected key, a refusal, an empty taxonomy. The sweep leaves it alone.
 *
 * "No key configured" is not a failure. The worker releases the job without using an attempt.
 */
export type FailureKind = "transient" | "lease" | "shape" | "permanent";

/** How many times the sweep puts one job back. Stored on the job as `payload.requeueCeiling`. */
export const AUTO_REQUEUE_CEILING = 5;
/** Wait before the first automatic requeue. Each further requeue doubles it. */
export const AUTO_REQUEUE_BASE_SECONDS = 15 * 60;
export const AUTO_REQUEUE_MAX_SECONDS = 6 * 60 * 60;
/** One manual or automatic call touches at most this many jobs. */
export const REQUEUE_BATCH = 500;

/** Failure kinds the sweep may requeue. A job with no recorded kind (failed before kinds existed) counts as transient. */
export const SWEEP_KINDS: readonly FailureKind[] = ["transient", "lease"];

/**
 * Why a job may be `skipped` and still come back. The unknown-sender daily cap sets a job aside without failing it;
 * an owner or admin puts it back after raising the cap, or the next day. The sweep never does: nothing about the
 * cap changes on its own before the day rolls over, and a person decides whether to spend the budget.
 */
export const REQUEUEABLE_SKIP_REASONS: readonly string[] = ["daily_cap"];

export const isRequeueableSkip = (job: { status: string; skipReason: string | null }): boolean =>
  job.status === "skipped" && job.skipReason !== null && REQUEUEABLE_SKIP_REASONS.includes(job.skipReason);

export function autoRequeueDelaySeconds(autoRequeues: number): number {
  return Math.min(AUTO_REQUEUE_MAX_SECONDS, AUTO_REQUEUE_BASE_SECONDS * 2 ** Math.max(0, autoRequeues));
}

export interface JobFailureState {
  failureKind: FailureKind | null;
  autoRequeues: number;
  requeueCeiling: number | null;
  failedAt: Date;
}

/** When the sweep may requeue this failed job, or null when it never will. */
export function nextAutoRequeueAt(job: JobFailureState): Date | null {
  if (!SWEEP_KINDS.includes(job.failureKind ?? "transient")) return null;
  if (job.autoRequeues >= (job.requeueCeiling ?? AUTO_REQUEUE_CEILING)) return null;
  return new Date(job.failedAt.getTime() + autoRequeueDelaySeconds(job.autoRequeues) * 1000);
}
