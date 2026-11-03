import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { jobRuns } from "./schema";

/**
 * The scheduler's own row. Nothing else says it stopped: a failed job logs, but a tick that never runs or never ends logs
 * nothing, and /api/health stays 200. Written at each start and finish, so a hung tick reads differently from a stopped one.
 */
const HEARTBEAT_JOB = "platform.heartbeat";
const HEARTBEAT_SLOT = "latest";

/** Longer than a tick's budget plus a missed minute or two. A scheduled deployment that ticks less often raises it. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;

async function write(values: { startedAt?: Date; finishedAt: Date | null }): Promise<void> {
  await db
    .insert(jobRuns)
    .values({ organizationId: null, job: HEARTBEAT_JOB, slot: HEARTBEAT_SLOT, status: "succeeded", startedAt: values.startedAt ?? new Date(), finishedAt: values.finishedAt })
    .onConflictDoUpdate({ target: [jobRuns.job, jobRuns.slot, jobRuns.organizationId], set: { ...(values.startedAt ? { startedAt: values.startedAt } : {}), finishedAt: values.finishedAt } });
}

/** Runs one tick between its two writes. A broken database reaches the tick's own report, so a failed write stops nothing. */
export async function withHeartbeat<T>(tick: () => Promise<T>): Promise<T> {
  await write({ startedAt: new Date(), finishedAt: null }).catch(() => undefined);
  try {
    return await tick();
  } finally {
    await write({ finishedAt: new Date() }).catch(() => undefined);
  }
}

export type SchedulerHealth = { state: "running" } | { state: "never" } | { state: "stopped"; since: Date } | { state: "hung"; since: Date };

export function schedulerHealthOf(row: { startedAt: Date; finishedAt: Date | null } | null, now: Date): SchedulerHealth {
  if (!row) return { state: "never" };
  const age = now.getTime() - row.startedAt.getTime();
  if (age < HEARTBEAT_STALE_MS) return { state: "running" };
  return row.finishedAt ? { state: "stopped", since: row.finishedAt } : { state: "hung", since: row.startedAt };
}

export async function readSchedulerHealth(now: Date): Promise<SchedulerHealth> {
  const [row] = await db
    .select({ startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, HEARTBEAT_JOB), eq(jobRuns.slot, HEARTBEAT_SLOT), isNull(jobRuns.organizationId)));
  return schedulerHealthOf(row ?? null, now);
}

/** A sentence for the operator, or null while all is well. A fresh install has not ticked yet, which is not a fault. */
export function schedulerProblem(health: SchedulerHealth): string | null {
  if (health.state === "stopped") return `Background jobs stopped running. The last tick finished at ${health.since.toISOString().slice(0, 16).replace("T", " ")} UTC, so sends and reply sync are waiting. Check that the scheduler is on (EMBEDDED_SCHEDULER) or that your cron can reach /api/jobs/tick (CRON_SECRET).`;
  if (health.state === "hung") return `A background tick started at ${health.since.toISOString().slice(0, 16).replace("T", " ")} UTC and has not finished. Restart the app if this does not clear.`;
  return null;
}
