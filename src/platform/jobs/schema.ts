import { sql } from "drizzle-orm";
import { check, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, tstz } from "@/platform/db/columns";

/**
 * Slot claims for scheduled jobs: inserting (job, slot, organization) is the
 * claim, so a slot runs once across restarts and overlapping instances. A
 * running claim carries a lease; a crashed run's lease expires and the slot
 * can be taken over.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: pk(),
    /** Null for instance-wide jobs. No FK: run history outlives an organization. */
    organizationId: uuid("organization_id"),
    job: text("job").notNull(),
    /** Identifies the time slot, for example 2026-10-14T09:30. */
    slot: text("slot").notNull(),
    status: text("status").notNull().default("running"),
    leaseUntil: tstz("lease_until"),
    startedAt: tstz("started_at").defaultNow().notNull(),
    finishedAt: tstz("finished_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("job_runs_job_slot_org_uq").on(t.job, t.slot, t.organizationId).nullsNotDistinct(),
    check("job_runs_status_ck", sql`${t.status} in ('running', 'succeeded', 'failed')`),
  ],
);
