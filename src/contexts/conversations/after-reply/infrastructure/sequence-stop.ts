import { and, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { lockPersonOutreachTx } from "@/platform/db/person-locks";
import { drafts, events, people, records } from "@/platform/db/schema";
import { sqlValues } from "@/platform/db/sql-values";
import { haltPersonEnrollmentsTx } from "@/contexts/outreach/infrastructure/enrollment-end";
import { RETIRABLE_DRAFT_STATUSES } from "../../domain/draft-status";
import { ACTIVE_RUN_STATUSES, OPEN_STEP_STATUSES, RUN_FROM, runReasonOfHalt, STEP_FROM, type RunStatus, type StepRunStatus } from "../domain/sequences";
import { sequenceRuns, sequenceStepRuns } from "./sequences-schema";
import type { FollowUpStop } from "@/contexts/outreach/application/inbound-ports";

/**
 * Ending a follow-up sequence run from inside another write's transaction. Every path that makes further contact
 * wrong (do not contact, unsubscribe, bounce, manual suppression, a terminal stage, a closed record, a reply)
 * calls one of these in the transaction that records the trigger, so the run stops and its unsent drafts retire
 * in the same commit. The 60 second sweep stays as a safety net. Conversations owns the runs, so outreach, a lower
 * layer, reaches `interruptEmailRunsTx` through its `FollowUpStop` port, which src/composition wires to this module.
 * The conversations core reaches Follow-ups after a reply through this module and, to restart a run, `createRunOn` and
 * `loadStartOn` in drizzle-sequence-store.ts. Every other file here depends on the core, not the other way.
 *
 * The run files write `records` in raw SQL: those writes leave `records.updated_at` alone, which a Drizzle update stamps
 * through `$onUpdate`. Their own tables they write with the query builder.
 */

export type Tx = DbTx;

export type StopFinal = "interrupted" | "cancelled";

/** Draft statuses a person has not acted on. A run that ends retires them; a send in flight is left alone. */
export const RETIRABLE_DRAFTS = sqlValues(RETIRABLE_DRAFT_STATUSES);
export const OPEN_STEPS = sqlValues(OPEN_STEP_STATUSES);

/**
 * The statuses a run may become `to` from (`RUN_FROM`). Every update that writes `sequence_runs.status` filters with it
 * (status-guards.test.ts).
 */
export const runMayBecome = (to: RunStatus) => inArray(sequenceRuns.status, [...RUN_FROM[to]]);
/**
 * The statuses a step run may become `to` from (`STEP_FROM`). Every update that writes `sequence_step_runs.status`
 * filters with it or with a narrower status check (status-guards.test.ts). The claim's lease takeover in `takeDueStep`
 * moves `drafting` to `drafting`, the one move outside the table.
 */
export const stepMayBecome = (to: StepRunStatus) => inArray(sequenceStepRuns.status, [...STEP_FROM[to]]);

/** Locks the record row: the first lock of every run write, which takes record, then run, then step run. */
export const lockRecordTx = (tx: Tx, organizationId: string, recordId: string) =>
  tx.select({ id: records.id }).from(records).where(and(eq(records.id, recordId), eq(records.organizationId, organizationId))).for("no key update");

/**
 * Writes an event of the record. It stays raw SQL: it copies the person and context version from the record row, and
 * stores an absent `from` or `to` as JSON `null`, where a Drizzle insert writes SQL NULL.
 */
export async function recordEvent(
  tx: Tx,
  input: { organizationId: string; recordId: string; type: string; actorUserId: string | null; from?: unknown; to?: unknown; meta?: Record<string, unknown> },
) {
  await tx.execute(sql`
    insert into events (organization_id, person_id, record_id, event_type, actor_type, actor_user_id, from_data, to_data, meta, context_version)
    select r.organization_id, r.person_id, r.id, ${input.type}, ${input.actorUserId ? "human" : "system"}, ${input.actorUserId}::uuid,
           ${JSON.stringify(input.from ?? null)}::jsonb, ${JSON.stringify(input.to ?? null)}::jsonb, ${JSON.stringify(input.meta ?? {})}::jsonb, r.context_version
    from records r where r.id = ${input.recordId} and r.organization_id = ${input.organizationId}`);
}

/**
 * Ends a run: its unsent steps are cancelled and the drafts waiting on them are retired. A draft written for the
 * run but not yet linked to a step (the worker is between the two writes) is found by its request and retired too.
 * Returns false when the run was already over. `final` is `interrupted` for a trigger and `cancelled` for a person's call.
 */
export async function endRunTx(tx: Tx, input: EndRunInput): Promise<boolean> {
  return (await endRunCountingTx(tx, input)) !== null;
}

type EndRunInput = { organizationId: string; runId: string; final: StopFinal; reason: string; now: Date; actorUserId?: string | null };

/** `endRunTx` that also reports how many drafts the same statement retired, or null when the run was already over. */
export async function endRunCountingTx(tx: Tx, input: EndRunInput): Promise<{ draftsRetired: number } | null> {
  const ofRun = and(eq(sequenceRuns.id, input.runId), eq(sequenceRuns.organizationId, input.organizationId));
  // Lock order everywhere is record, then run. A worker holding the run waits for the record, so taking the run first here could deadlock.
  const [peek] = await tx.select({ recordId: sequenceRuns.recordId }).from(sequenceRuns).where(ofRun);
  if (!peek) return null;
  await lockRecordTx(tx, input.organizationId, peek.recordId);
  const [run] = await tx.select({ recordId: sequenceRuns.recordId, status: sequenceRuns.status }).from(sequenceRuns).where(ofRun).for("update");
  if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
  const retired = await tx
    .update(drafts)
    .set({ status: "stale", error: "The follow-up sequence ended.", updatedAt: input.now })
    .where(
      and(
        eq(drafts.organizationId, input.organizationId),
        inArray(drafts.status, [...RETIRABLE_DRAFT_STATUSES]),
        or(
          inArray(
            drafts.id,
            tx
              .select({ id: sequenceStepRuns.draftId })
              .from(sequenceStepRuns)
              .where(and(eq(sequenceStepRuns.sequenceRunId, input.runId), isNotNull(sequenceStepRuns.draftId), inArray(sequenceStepRuns.status, [...OPEN_STEP_STATUSES]))),
          ),
          sql`${drafts.request}->>'sequenceRunId' = ${input.runId}`,
        ),
      ),
    )
    .returning({ id: drafts.id });
  await tx
    .update(sequenceStepRuns)
    .set({ status: "cancelled", claimToken: null, updatedAt: input.now })
    .where(and(eq(sequenceStepRuns.sequenceRunId, input.runId), eq(sequenceStepRuns.organizationId, input.organizationId), stepMayBecome("cancelled")));
  await tx.update(sequenceRuns).set({ status: input.final, updatedAt: input.now }).where(and(eq(sequenceRuns.id, input.runId), runMayBecome(input.final)));
  await tx.execute(sql`update records set next_action_at = null where id = ${run.recordId} and organization_id = ${input.organizationId} and workflow_state = 'waiting'`);
  await recordEvent(tx, {
    organizationId: input.organizationId,
    recordId: run.recordId,
    type: input.final === "interrupted" ? "sequence.interrupted" : "sequence.cancelled",
    actorUserId: input.actorUserId ?? null,
    from: { sequenceRunId: input.runId, status: run.status },
    to: { sequenceRunId: input.runId, status: input.final },
    meta: { reason: input.reason },
  });
  return { draftsRetired: retired.length };
}

async function interruptRuns(tx: Tx, organizationId: string, runIds: string[], reason: string, now: Date): Promise<number> {
  let ended = 0;
  for (const runId of runIds) if (await endRunTx(tx, { organizationId, runId, final: "interrupted", reason, now })) ended += 1;
  return ended;
}

/**
 * Ends every active or paused run of one record. `exceptReplyTypeId` spares a run that started at that
 * subcategory, so a sequence assigned to a terminal subcategory is not cancelled by its own start.
 */
export async function interruptRecordRunsTx(tx: Tx, organizationId: string, recordId: string, reason: string, now: Date, exceptReplyTypeId?: string): Promise<number> {
  const runs = await tx
    .select({ id: sequenceRuns.id })
    .from(sequenceRuns)
    .where(
      and(
        eq(sequenceRuns.organizationId, organizationId),
        eq(sequenceRuns.recordId, recordId),
        inArray(sequenceRuns.status, [...ACTIVE_RUN_STATUSES]),
        exceptReplyTypeId ? ne(sequenceRuns.replyTypeId, exceptReplyTypeId) : undefined,
      ),
    )
    .orderBy(sequenceRuns.id);
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

/** The ids of the live runs whose record matches `where`, in id order. Every join stays inside the organization. */
const liveRunsOf = (tx: Tx, organizationId: string, where: SQL) =>
  tx
    .select({ id: sequenceRuns.id })
    .from(sequenceRuns)
    .innerJoin(records, and(eq(records.id, sequenceRuns.recordId), eq(records.organizationId, sequenceRuns.organizationId)))
    .innerJoin(people, and(eq(people.id, records.personId), eq(people.organizationId, sequenceRuns.organizationId)))
    .where(and(eq(sequenceRuns.organizationId, organizationId), inArray(sequenceRuns.status, [...ACTIVE_RUN_STATUSES]), where))
    .orderBy(sequenceRuns.id);

/** Ends the runs of every record of the given people. */
export async function interruptPersonRunsTx(tx: Tx, organizationId: string, personIds: string[], reason: string, now: Date): Promise<number> {
  if (personIds.length === 0) return 0;
  const runs = await liveRunsOf(tx, organizationId, inArray(records.personId, personIds));
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

/** Ends the runs of every person in the organization with this address (case-insensitive). */
export async function interruptEmailRunsTx(tx: Tx, organizationId: string, email: string, reason: string, now: Date): Promise<number> {
  const runs = await liveRunsOf(tx, organizationId, sql`lower(${people.email}) = ${email.trim().toLowerCase()}`);
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

export interface ReplyStopResult {
  /** Enrollments moved from pending or active to replied, across every channel and campaign. */
  enrollmentsStopped: number;
  runsEnded: number;
}

/**
 * A genuine reply (not an auto-reply, not an unverified bounce) ends all outreach to the person on every channel:
 * their pending and active campaign enrollments become `replied` and their active or paused sequence runs are
 * interrupted, in the transaction that stores the message. The person is the one the message was filed under, plus
 * anyone in the organization whose address equals `senderEmail` (mail without thread headers, or from a new thread).
 * Replaying the same message stops nothing more and writes no second event.
 */
export async function stopPersonOutreachOnReplyTx(
  tx: Tx,
  input: { organizationId: string; personId: string; senderEmail?: string | null; channel: "email" | "linkedin"; now: Date },
): Promise<ReplyStopResult> {
  const sender = input.senderEmail?.trim().toLowerCase() || null;
  const found = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.organizationId, input.organizationId), or(eq(people.id, input.personId), sender ? sql`lower(${people.email}) = ${sender}` : undefined)))
    .orderBy(people.id);
  const personIds = found.map((p) => p.id);
  if (personIds.length === 0) return { enrollmentsStopped: 0, runsEnded: 0 };
  // Same lock as a restore of a removed lead (drizzle-enrollment-restore): one of the two commits first and the other sees it.
  await lockPersonOutreachTx(tx, input.organizationId, personIds);

  const stopped = await haltPersonEnrollmentsTx(tx, input.organizationId, personIds, "replied", input.now);
  const runsEnded = await interruptPersonRunsTx(tx, input.organizationId, personIds, "reply", input.now);

  for (const personId of new Set(stopped.map((e) => e.personId))) {
    const own = stopped.filter((e) => e.personId === personId);
    await tx.insert(events).values({
      organizationId: input.organizationId,
      personId,
      eventType: "outreach.stopped_by_reply",
      actorType: "system",
      toData: { status: "replied" },
      meta: { replyChannel: input.channel, enrollmentIds: own.map((e) => e.id), channels: [...new Set(own.map((e) => e.channel))] },
    });
  }
  return { enrollmentsStopped: stopped.length, runsEnded };
}

/** Outreach's view of these runs: src/composition hands it to outreach's suppression store. */
export const followUpStop: FollowUpStop = {
  endEmailRunsTx: (tx, organizationId, email, halt, now) => interruptEmailRunsTx(tx, organizationId, email, runReasonOfHalt(halt), now),
};
