import { and, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { jobRuns } from "./schema";

/**
 * Slot claims on `job_runs`: work that must run once per period (a day, an
 * hour) claims `(job, slotKey, organization)` before it starts.
 *
 * - First caller inserts the row and owns it for `leaseMs`.
 * - A second caller finds the row and gets null while the lease is live or the
 *   slot succeeded.
 * - A crashed owner leaves `running` with an expired lease, so the next caller
 *   takes it over. A failed slot is retaken after its retry delay.
 * - The claim is fenced by `startedAt`: a late `finishSlot` or `extendSlot`
 *   from a displaced owner changes nothing.
 */
export interface SlotClaim {
  id: string;
  job: string;
  slotKey: string;
  organizationId: string | null;
  /** The claim's fence. */
  startedAt: Date;
}

export interface ClaimSlotOptions {
  organizationId?: string | null;
  now?: Date;
  /** How long the owner may run before another caller may take over. Default 5 minutes. */
  leaseMs?: number;
}

export const DEFAULT_SLOT_LEASE_MS = 5 * 60_000;

export async function claimSlot(job: string, slotKey: string, options: ClaimSlotOptions = {}): Promise<SlotClaim | null> {
  const now = options.now ?? new Date();
  const organizationId = options.organizationId ?? null;
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_SLOT_LEASE_MS));
  const [row] = await db
    .insert(jobRuns)
    .values({ organizationId, job, slot: slotKey, status: "running", leaseUntil, startedAt: now })
    .onConflictDoUpdate({
      target: [jobRuns.job, jobRuns.slot, jobRuns.organizationId],
      set: { status: "running", leaseUntil, startedAt: now, finishedAt: null, error: null },
      setWhere: and(
        sql`${jobRuns.status} <> 'succeeded'`,
        sql`(${jobRuns.leaseUntil} is null or ${jobRuns.leaseUntil} <= ${now.toISOString()}::timestamptz)`,
      ),
    })
    .returning({ id: jobRuns.id });
  return row ? { id: row.id, job, slotKey, organizationId, startedAt: now } : null;
}

const fence = (claim: SlotClaim) =>
  and(eq(jobRuns.id, claim.id), eq(jobRuns.status, "running"), eq(jobRuns.startedAt, claim.startedAt));

/** Extend the lease of a long run. False means the claim was lost. */
export async function extendSlot(claim: SlotClaim, leaseMs: number, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(jobRuns)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
    .where(fence(claim))
    .returning({ id: jobRuns.id });
  return rows.length === 1;
}

export type SlotOutcome =
  | { status: "succeeded" }
  /** The slot opens again after `retryAfterMs` (default 5 minutes). Zero means the next tick. */
  | { status: "failed"; error: string; retryAfterMs?: number };

/** Mark the claim done. False means the claim was lost to a takeover and nothing changed. */
export async function finishSlot(claim: SlotClaim, outcome: SlotOutcome, now: Date = new Date()): Promise<boolean> {
  const ok = outcome.status === "succeeded";
  const rows = await db
    .update(jobRuns)
    .set({
      status: outcome.status,
      finishedAt: now,
      error: ok ? null : outcome.error.slice(0, 2000),
      leaseUntil: ok ? null : new Date(now.getTime() + (outcome.retryAfterMs ?? DEFAULT_SLOT_LEASE_MS)),
    })
    .where(fence(claim))
    .returning({ id: jobRuns.id });
  return rows.length === 1;
}
