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
  run(ctx: TickContext): Promise<JobResult>;
}

export interface TickReport {
  startedAt: string;
  durationMs: number;
  jobs: Array<{ name: string; processed: number; more: boolean; detail?: Record<string, number>; error?: string; durationMs?: number }>;
}
