import { sql } from "drizzle-orm";
import { dueAfter, isTerminalSubcategory, isValidZone } from "../domain/sequences";
import { interruptRecordRunsTx, recordEvent, type Tx } from "@/platform/db/sequence-stop";

export { endRunTx, interruptRecordRunsTx, recordEvent, type Tx } from "@/platform/db/sequence-stop";

export const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** Raw `db.execute` rows hand timestamps back as strings. */
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
export const asDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : asDate(value));

export const rowsOf = <T>(result: unknown) => result as unknown as T[];

export async function zoneOfTx(tx: Tx, organizationId: string): Promise<string> {
  const [row] = rowsOf<{ zone: string | null }>(await tx.execute(sql`select "values"->>'timeZone' as zone from channel_settings where organization_id = ${organizationId} and channel = 'general'`));
  return row?.zone && isValidZone(row.zone) ? row.zone : "UTC";
}

/**
 * Drafts nobody has acted on turn `stale` with `reason`: a new inbound message, a stage move or a correction made the
 * text outdated. A draft that is sending or already sent stays as it is. Returns how many changed.
 */
export async function staleOpenDraftsTx(tx: Tx, input: { organizationId: string; recordId: string; reason: string; now: Date }): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update drafts set status = 'stale', error = ${input.reason}, updated_at = ${ts(input.now)}
      where organization_id = ${input.organizationId} and record_id = ${input.recordId} and status in ('generating', 'awaiting_review', 'failed')
      returning id`),
  );
  return rows.length;
}

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
 * A record moved to a terminal subcategory (a refusal, a wrong or departed contact, a customer): its runs end in the
 * caller's transaction. A run that started at that same subcategory is spared, as in the sweep's rule.
 */
export async function interruptOnTerminalStageTx(
  tx: Tx,
  input: { organizationId: string; recordId: string; categoryKey: string | null; subcategoryKey: string | null; subcategoryId: string | null; now: Date },
): Promise<number> {
  if (!isTerminalSubcategory(input.categoryKey, input.subcategoryKey)) return 0;
  return interruptRecordRunsTx(tx, input.organizationId, input.recordId, "terminal_stage", input.now, input.subcategoryId ?? undefined);
}
