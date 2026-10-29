import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { records, replyTypes } from "@/platform/db/schema";
import { dueAfter, type StepRunStatus } from "../domain/sequences";
import { interruptRecordRunsTx, recordEvent, runMayBecome, type Tx } from "./sequence-stop";
import { sequenceRuns, sequenceSteps, sequenceStepRuns } from "./sequences-schema";
import type { FollowUpsOutcome, FollowUpsRule } from "../../domain/reply-type";

export const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** Raw `db.execute` rows hand timestamps back as strings. */
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
export const asDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : asDate(value));

/**
 * The steps `advanceRunTx` may schedule next. A `scheduled` step keeps its status and takes the new due time; a
 * `failed` one goes back to `scheduled`, a move `STEP_FROM` allows. Both the pick and the write filter on it.
 */
const SCHEDULABLE: readonly StepRunStatus[] = ["scheduled", "failed"];

/**
 * After a step is sent or skipped: the next open step comes due its own delay after `from`, or the run completes.
 * The caller holds the run's lock.
 */
export async function advanceRunTx(tx: Tx, input: { organizationId: string; runId: string; afterPosition: number; from: Date; now: Date }): Promise<{ next: number | null }> {
  const [run] = await tx.select({ recordId: sequenceRuns.recordId, status: sequenceRuns.status }).from(sequenceRuns).where(eq(sequenceRuns.id, input.runId)).for("update");
  // A stop that committed while this transaction waited for the lock wins: nothing is rescheduled or completed.
  if (!run || run.status !== "active") return { next: null };
  const [next] = await tx
    .select({ id: sequenceStepRuns.id, position: sequenceSteps.position, delayMinutes: sequenceSteps.delayMinutes })
    .from(sequenceStepRuns)
    .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceStepRuns.sequenceStepId))
    .where(and(eq(sequenceStepRuns.sequenceRunId, input.runId), inArray(sequenceStepRuns.status, [...SCHEDULABLE]), gt(sequenceSteps.position, input.afterPosition)))
    .orderBy(asc(sequenceSteps.position))
    .limit(1);
  if (!next) {
    await tx.update(sequenceRuns).set({ status: "completed", updatedAt: input.now }).where(and(eq(sequenceRuns.id, input.runId), runMayBecome("completed")));
    await tx.execute(sql`update records set next_action_at = null, workflow_state = case when workflow_state = 'waiting' then 'idle' else workflow_state end where id = ${run.recordId} and organization_id = ${input.organizationId}`);
    await recordEvent(tx, { organizationId: input.organizationId, recordId: run.recordId, type: "sequence.completed", actorUserId: null, to: { sequenceRunId: input.runId } });
    return { next: null };
  }
  const due = dueAfter(input.from, next.delayMinutes, await organizationTimeZone(input.organizationId, tx));
  await tx
    .update(sequenceStepRuns)
    .set({ status: "scheduled", dueAt: due, updatedAt: input.now })
    .where(and(eq(sequenceStepRuns.id, next.id), inArray(sequenceStepRuns.status, [...SCHEDULABLE])));
  await tx.update(sequenceRuns).set({ currentStepPosition: next.position, updatedAt: input.now }).where(eq(sequenceRuns.id, input.runId));
  await tx.execute(sql`update records set next_action_at = ${ts(due)} where id = ${run.recordId} and organization_id = ${input.organizationId} and workflow_state in ('waiting', 'idle')`);
  return { next: next.position };
}

/**
 * A record moved to a reply type whose follow-ups stop: its runs end in the caller's transaction. A run that started at
 * that same type is spared, as in the sweep's rule. The caller's `followUps` (the decision of `decideReplyType`) is
 * the rule. A caller that passes none gets the Follow-ups rule of the record's current reply type, read here, so the
 * caller writes the record first. No key or group decides.
 */
export async function interruptOnTerminalStageTx(
  tx: Tx,
  input: {
    organizationId: string;
    recordId: string;
    replyTypeId: string | null;
    followUps?: FollowUpsOutcome;
    now: Date;
  },
): Promise<number> {
  const followUps = input.followUps ?? (await currentFollowUpsTx(tx, input.organizationId, input.recordId));
  if (followUps !== "stop") return 0;
  return interruptRecordRunsTx(tx, input.organizationId, input.recordId, "terminal_stage", input.now, input.replyTypeId ?? undefined);
}

/** The Follow-ups rule of the record's current reply type, or null when the record has none. */
async function currentFollowUpsTx(tx: Tx, organizationId: string, recordId: string): Promise<FollowUpsRule | null> {
  const [row] = await tx
    .select({ followUps: replyTypes.followUps })
    .from(records)
    .innerJoin(replyTypes, and(eq(replyTypes.id, records.replyTypeId), eq(replyTypes.organizationId, records.organizationId)))
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)));
  return row?.followUps ?? null;
}
