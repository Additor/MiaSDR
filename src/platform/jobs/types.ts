import type { ClaimSlotOptions, SlotClaim, SlotOutcome } from "./slots";

/**
 * A job is a unit of recurring work. It claims its own work (SKIP LOCKED or a
 * DB slot) and stops when the tick budget runs out, so several callers can
 * invoke a tick at once without double-processing.
 */
export interface TickContext {
  /** Epoch ms after which the job must return. */
  deadline: number;
  now: () => Date;
}

export interface JobResult {
  /** Items handled during this tick. */
  processed: number;
  /** True when more work remains and the caller should tick again soon. */
  more: boolean;
  /** Optional named counts for the tick report, such as outcomes per kind. */
  detail?: Record<string, number>;
}

export interface Job {
  /** Stable id, used in logs and tick reports. */
  name: string;
  /**
   * The `detail` keys that mean something went wrong. A job states them, since a run that returns normally is not a healthy
   * one: a provider refusing every send still returns. Empty for a job with nothing of the kind to report.
   */
  failureKeys: readonly string[];
  run(ctx: TickContext): Promise<JobResult>;
}

export interface TickReport {
  startedAt: string;
  durationMs: number;
  jobs: Array<{ name: string; processed: number; more: boolean; detail?: Record<string, number>; failures?: Record<string, number>; error?: string; durationMs?: number }>;
}

/** Once-per-period claims on `job_runs` (see ./slots), handed to a job as a port so application code never opens the database. */
export interface SlotPort {
  claim(job: string, slotKey: string, options?: ClaimSlotOptions): Promise<SlotClaim | null>;
  finish(claim: SlotClaim, outcome: SlotOutcome, now?: Date): Promise<boolean>;
}
