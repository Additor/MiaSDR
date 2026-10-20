import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { env } from "@/shared/env";
import { claimSlot, finishSlot } from "./slots";
import type { Job, JobResult } from "./types";

const DAY_MS = 86_400_000;
export const PRUNE_BATCH_SIZE = 1000;
/** Batches per table per tick, so one tick stays short even after a long outage. */
export const PRUNE_MAX_BATCHES = 20;
/** Expired sessions and verifications are kept this long past expiry. */
export const AUTH_EXPIRED_GRACE_DAYS = 1;

export interface RetentionDays {
  jobRuns: number;
  inboundDone: number;
  inboundFailed: number;
  aiJobs: number;
}

export const DEFAULT_RETENTION: RetentionDays = { jobRuns: 30, inboundDone: 30, inboundFailed: 90, aiJobs: 30 };

export function retentionFromEnv(): RetentionDays {
  const e = env();
  return {
    jobRuns: e.RETENTION_JOB_RUNS_DAYS,
    inboundDone: e.RETENTION_INBOUND_EVENTS_DAYS,
    inboundFailed: e.RETENTION_INBOUND_FAILED_DAYS,
    aiJobs: e.RETENTION_AI_JOBS_DAYS,
  };
}

export interface PruneOptions {
  now: Date;
  retention: RetentionDays;
  deadline: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface PruneResult {
  deleted: Record<string, number>;
  /** True when a table still had old rows when the batch cap or the deadline stopped the run. */
  more: boolean;
}

/**
 * Delete rows in `batch`-sized chunks. `where` is the full eligibility
 * condition, evaluated per batch, so rows that became eligible or were
 * claimed meanwhile are handled correctly. SKIP LOCKED leaves rows another
 * transaction holds.
 */
async function deleteBatches(table: string, where: ReturnType<typeof sql>, o: Required<Pick<PruneOptions, "batchSize" | "maxBatches" | "deadline">>) {
  let total = 0;
  for (let i = 0; i < o.maxBatches; i++) {
    if (Date.now() >= o.deadline) return { total, more: true };
    const res = await db.execute(sql`
      delete from ${sql.raw(table)} where id in (
        select id from ${sql.raw(table)} where ${where} limit ${o.batchSize} for update skip locked
      )`);
    const n = (res as unknown as { count: number }).count;
    total += n;
    if (n < o.batchSize) return { total, more: false };
  }
  return { total, more: true };
}

/**
 * Prune finished history. Touches only operational logs: job claims, terminal
 * provider events, finished AI jobs, expired auth rows. Better Auth deletes an
 * expired session or verification only when it is read again, so abandoned
 * ones pile up and are removed here.
 */
export async function pruneHistory(options: PruneOptions): Promise<PruneResult> {
  const { now, retention } = options;
  const o = { batchSize: options.batchSize ?? PRUNE_BATCH_SIZE, maxBatches: options.maxBatches ?? PRUNE_MAX_BATCHES, deadline: options.deadline };
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const authCutoff = before(AUTH_EXPIRED_GRACE_DAYS);

  const plan: Array<[string, ReturnType<typeof sql>]> = [
    ["job_runs", sql`started_at < ${before(retention.jobRuns)}::timestamptz and (status <> 'running' or lease_until is null or lease_until < ${nowIso}::timestamptz)`],
    ["inbound_events_done", sql`status in ('done', 'skipped') and coalesce(processed_at, created_at) < ${before(retention.inboundDone)}::timestamptz`],
    ["inbound_events_failed", sql`status = 'failed' and coalesce(processed_at, created_at) < ${before(retention.inboundFailed)}::timestamptz`],
    ["ai_jobs", sql`status = 'succeeded' and completed_at < ${before(retention.aiJobs)}::timestamptz`],
    ["sessions", sql`expires_at < ${authCutoff}::timestamptz`],
    ["verifications", sql`expires_at < ${authCutoff}::timestamptz`],
  ];
  const tableOf = (key: string) => (key.startsWith("inbound_events") ? "inbound_events" : key);

  const deleted: Record<string, number> = {};
  let more = false;
  for (const [key, where] of plan) {
    const r = await deleteBatches(tableOf(key), where, o);
    deleted[key] = r.total;
    more ||= r.more;
  }
  return { deleted, more };
}

/** Local-independent: prune slots follow the UTC day. */
export const pruneSlotKey = (now: Date) => now.toISOString().slice(0, 10);

/** Once a day (UTC) by slot claim. A run cut off by budget or batch cap resumes on the next tick. */
export function createHistoryPruneJob(retention: () => RetentionDays = retentionFromEnv): Job {
  return {
    name: "platform.history-prune",
    async run(ctx): Promise<JobResult> {
      const now = ctx.now();
      const claim = await claimSlot("history-prune", pruneSlotKey(now), { now, leaseMs: 10 * 60_000 });
      if (!claim) return { processed: 0, more: false };
      try {
        const result = await pruneHistory({ now, retention: retention(), deadline: ctx.deadline });
        if (result.more) await finishSlot(claim, { status: "failed", error: "Cut short, resumes on the next tick.", retryAfterMs: 0 });
        else await finishSlot(claim, { status: "succeeded" });
        const processed = Object.values(result.deleted).reduce((a, b) => a + b, 0);
        return { processed, more: result.more, detail: result.deleted };
      } catch (error) {
        await finishSlot(claim, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}
