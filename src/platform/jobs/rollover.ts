import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { jobRuns } from "@/platform/db/schema";
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

/** Every organization with its IANA zone, in id order. Tenancy answers it; src/composition passes it in. */
export type OrganizationZones = () => Promise<Array<{ organizationId: string; timeZone: string }>>;

/** Each organization's local day in its zone. */
export async function organizationDays(zones: OrganizationZones, now: Date): Promise<OrganizationDay[]> {
  return (await zones()).map((z) => ({ organizationId: z.organizationId, day: localDay(now, z.timeZone) }));
}

/**
 * Per organization and step, one slot claim per local day. A step that fails,
 * or is cut off by the tick budget, leaves the others done and is picked up on
 * a later tick. Organizations with every step finished cost one query in total.
 */
export function createDailyRolloverJob(steps: readonly RolloverStep[], zones: OrganizationZones): Job {
  return {
    name: "platform.daily-rollover",
    async run(ctx): Promise<JobResult> {
      if (steps.length === 0) return { processed: 0, more: false };
      const now = ctx.now();
      const days = await organizationDays(zones, now);
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
