import { sql } from "drizzle-orm";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { dueAfter, isTerminalReplyType } from "../domain/sequences";
import { interruptRecordRunsTx, recordEvent, type Tx } from "./sequence-stop";
import { rowsOf } from "@/platform/db/sql-values";
import type { FollowUpsOutcome } from "../../domain/reply-type";

export const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** Raw `db.execute` rows hand timestamps back as strings. */
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
export const asDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : asDate(value));

/** The organization's zone, read inside the run's transaction. */
export const zoneOfTx = (tx: Tx, organizationId: string): Promise<string> => organizationTimeZone(organizationId, tx);

/**
 * After a step is sent or skipped: the next open step comes due its own delay after `from`, or the run completes.
 * The caller holds the run's lock.
 */
export async function advanceRunTx(tx: Tx, input: { organizationId: string; runId: string; afterPosition: number; from: Date; now: Date }): Promise<{ next: number | null }> {
  const [run] = rowsOf<{ record_id: string; status: string }>(await tx.execute(sql`select record_id, status from sequence_runs where id = ${input.runId} for update`));
  // A stop that committed while this transaction waited for the lock wins: nothing is rescheduled or completed.
  if (!run || run.status !== "active") return { next: null };
  const [next] = rowsOf<{ id: string; position: number; delay_minutes: number }>(
    await tx.execute(sql`
      select sr.id, st.position, st.delay_minutes
      from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id
      where sr.sequence_run_id = ${input.runId} and sr.status in ('scheduled', 'failed') and st.position > ${input.afterPosition}
      order by st.position limit 1`),
  );
  if (!next) {
    await tx.execute(sql`update sequence_runs set status = 'completed', updated_at = ${ts(input.now)} where id = ${input.runId}`);
    await tx.execute(sql`update records set next_action_at = null, workflow_state = case when workflow_state = 'waiting' then 'idle' else workflow_state end where id = ${run.record_id} and organization_id = ${input.organizationId}`);
    await recordEvent(tx, { organizationId: input.organizationId, recordId: run.record_id, type: "sequence.completed", actorUserId: null, to: { sequenceRunId: input.runId } });
    return { next: null };
  }
  const due = dueAfter(input.from, next.delay_minutes, await zoneOfTx(tx, input.organizationId));
  await tx.execute(sql`update sequence_step_runs set due_at = ${ts(due)}, status = 'scheduled', updated_at = ${ts(input.now)} where id = ${next.id}`);
  await tx.execute(sql`update sequence_runs set current_step_position = ${next.position}, updated_at = ${ts(input.now)} where id = ${input.runId}`);
  await tx.execute(sql`update records set next_action_at = ${ts(due)} where id = ${run.record_id} and organization_id = ${input.organizationId} and workflow_state in ('waiting', 'idle')`);
  return { next: next.position };
}

/**
 * A record moved to a reply type whose follow-ups stop: its runs end in the caller's transaction. A run that started at
 * that same type is spared, as in the sweep's rule. A caller that passes `followUps` (the decision of `decideReplyType`)
 * decides by it; without it the key and group rule `isTerminalReplyType` decides, until every caller passes it.
 */
export async function interruptOnTerminalStageTx(
  tx: Tx,
  input: {
    organizationId: string;
    recordId: string;
    groupKey: string | null;
    replyTypeKey: string | null;
    replyTypeId: string | null;
    followUps?: FollowUpsOutcome;
    now: Date;
  },
): Promise<number> {
  const stops = input.followUps === undefined ? isTerminalReplyType(input.groupKey, input.replyTypeKey) : input.followUps === "stop";
  if (!stops) return 0;
  return interruptRecordRunsTx(tx, input.organizationId, input.recordId, "terminal_stage", input.now, input.replyTypeId ?? undefined);
}
