import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, jobRuns, organizations } from "@/platform/db/schema";
import { localDay } from "./local-day";
import { claimSlot, finishSlot } from "./slots";
import type { Job, JobResult } from "./types";

/**
 * A rollover step runs once per organization per local day. It must be
 * idempotent: a crash between the work and the completion mark runs it again.
 */
export interface RolloverStep {
  /** Stable name, part of the claim key. Lowercase words with dashes. */
  name: string;
  run(input: { organizationId: string; day: string; now: Date }): Promise<void>;
}

export const ROLLOVER_LEASE_MS = 5 * 60_000;
export const ROLLOVER_RETRY_MS = 5 * 60_000;

/** The claim key of one step for one organization and day, as in the spec: daily-rollover:<org>:<step>:<yyyy-mm-dd>. */
export const rolloverJobName = (organizationId: string, step: string, day: string) =>
  `daily-rollover:${organizationId}:${step}:${day}`;

export interface OrganizationDay {
  organizationId: string;
  day: string;
}

/** Each organization's local day, from channel_settings general.timeZone (UTC when unset or unknown). */
export async function organizationDays(now: Date): Promise<OrganizationDay[]> {
  const rows = await db
    .select({ id: organizations.id, zone: sql<string | null>`${channelSettings.values} ->> 'timeZone'` })
    .from(organizations)
    .leftJoin(channelSettings, and(eq(channelSettings.organizationId, organizations.id), eq(channelSettings.channel, "general")))
    .orderBy(organizations.id);
  return rows.map((r) => ({ organizationId: r.id, day: localDay(now, r.zone) }));
}

/**
 * Per organization and step, one slot claim per local day. A step that fails,
 * or is cut off by the tick budget, leaves the others done and is picked up on
 * a later tick. Organizations with every step finished cost one query in total.
 */
export function createDailyRolloverJob(steps: readonly RolloverStep[]): Job {
  return {
    name: "platform.daily-rollover",
    async run(ctx): Promise<JobResult> {
      if (steps.length === 0) return { processed: 0, more: false };
      const now = ctx.now();
      const days = await organizationDays(now);
      const names = days.flatMap((d) => steps.map((s) => rolloverJobName(d.organizationId, s.name, d.day)));
      const done = new Set<string>();
      if (names.length > 0) {
        const rows = await db
          .select({ job: jobRuns.job })
          .from(jobRuns)
          .where(and(inArray(jobRuns.job, names), eq(jobRuns.status, "succeeded")));
        for (const r of rows) done.add(r.job);
      }

      let ran = 0;
      let failed = 0;
      let more = false;
      for (const { organizationId, day } of days) {
        for (const step of steps) {
          const job = rolloverJobName(organizationId, step.name, day);
          if (done.has(job)) continue;
          if (Date.now() >= ctx.deadline) {
            more = true;
            continue;
          }
          const claim = await claimSlot(job, day, { organizationId, now, leaseMs: ROLLOVER_LEASE_MS });
          if (!claim) continue;
          try {
            await step.run({ organizationId, day, now });
            await finishSlot(claim, { status: "succeeded" });
            ran++;
          } catch (error) {
            failed++;
            await finishSlot(claim, { status: "failed", error: error instanceof Error ? error.message : String(error), retryAfterMs: ROLLOVER_RETRY_MS });
          }
        }
      }
      return { processed: ran, more, detail: { organizations: days.length, steps: ran, failed } };
    },
  };
}
