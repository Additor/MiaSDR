import { and, desc, like, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { jobRuns } from "./schema";

/** Failure records live in `job_runs` under this job-name prefix, one row per job and error signature. */
export const TICK_FAILURE_PREFIX = "tick:";

export interface TickFailure {
  job: string;
  /** Error text with numbers and ids removed. Two failures with the same signature share one row. */
  signature: string;
  message: string;
  /** Times the failure happened since this process first saw it. */
  occurrences: number;
  firstSeenAt: Date;
  now: Date;
}

const MESSAGE_LIMIT = 500;

/**
 * Upserts the failure record: a repeat updates the same row, so a job that fails every minute adds no rows. The
 * count lives in the text because `job_runs` has no counter column, and the next write replaces the whole text.
 */
export async function recordTickFailure(f: TickFailure): Promise<void> {
  const error = `${f.message.slice(0, MESSAGE_LIMIT)}${f.occurrences > 1 ? ` (${f.occurrences} times since ${f.firstSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`;
  await db
    .insert(jobRuns)
    .values({ organizationId: null, job: `${TICK_FAILURE_PREFIX}${f.job}`, slot: `failure:${f.signature}`.slice(0, 200), status: "failed", startedAt: f.firstSeenAt, finishedAt: f.now, error })
    .onConflictDoUpdate({
      target: [jobRuns.job, jobRuns.slot, jobRuns.organizationId],
      // startedAt keeps the first sighting of the row; finishedAt is the latest.
      set: { status: "failed", finishedAt: f.now, error, leaseUntil: null },
    });
}

export interface TickFailureRow {
  id: string;
  job: string;
  error: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export async function recentTickFailures(limit: number): Promise<TickFailureRow[]> {
  const rows = await db
    .select({ id: jobRuns.id, job: jobRuns.job, error: jobRuns.error, startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(like(jobRuns.job, `${TICK_FAILURE_PREFIX}%`)))
    .orderBy(desc(sql`coalesce(${jobRuns.finishedAt}, ${jobRuns.startedAt})`))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, job: r.job.slice(TICK_FAILURE_PREFIX.length), error: r.error ?? "", firstSeenAt: r.startedAt, lastSeenAt: r.finishedAt ?? r.startedAt }));
}
