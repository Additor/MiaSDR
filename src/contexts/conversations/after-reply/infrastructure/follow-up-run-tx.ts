import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { conversations, replyTypes } from "@/platform/db/schema";
import { dueAfter, type StepRunStatus } from "../domain/follow-ups";
import { interruptConversationRunsTx, recordEvent, runMayBecome, type Tx } from "./follow-up-stop";
import { followUpRuns, followUpSteps, followUpStepRuns } from "./follow-ups-schema";
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
 * The step `advanceRunTx` picked moved off `scheduled` and `failed` before its write. The caller's transaction must roll
 * back, the settled step's own write included, so the run never stays on a step it handled with nothing scheduled next.
 */
export class StepMovedError extends Error {
  constructor(readonly runId: string) {
    super("The next follow-up step changed while the run advanced.");
    this.name = "StepMovedError";
  }
}

/**
 * After a step is sent or skipped: the next open step comes due its own delay after `from`, or the run completes.
 * The caller holds the run's lock.
 */
export async function advanceRunTx(tx: Tx, input: { organizationId: string; runId: string; afterPosition: number; from: Date; now: Date }): Promise<{ next: number | null }> {
  const [run] = await tx.select({ conversationId: followUpRuns.conversationId, status: followUpRuns.status }).from(followUpRuns).where(eq(followUpRuns.id, input.runId)).for("update");
  // A stop that committed while this transaction waited for the lock wins: nothing is rescheduled or completed.
  if (!run || run.status !== "active") return { next: null };
  const [next] = await tx
    .select({ id: followUpStepRuns.id, position: followUpSteps.position, delayMinutes: followUpSteps.delayMinutes })
    .from(followUpStepRuns)
    .innerJoin(followUpSteps, eq(followUpSteps.id, followUpStepRuns.followUpStepId))
    .where(and(eq(followUpStepRuns.followUpRunId, input.runId), inArray(followUpStepRuns.status, [...SCHEDULABLE]), gt(followUpSteps.position, input.afterPosition)))
    .orderBy(asc(followUpSteps.position))
    .limit(1);
  if (!next) {
    await tx.update(followUpRuns).set({ status: "completed", updatedAt: input.now }).where(and(eq(followUpRuns.id, input.runId), runMayBecome("completed")));
    await tx.execute(sql`update conversations set next_action_at = null, workflow_state = case when workflow_state = 'waiting' then 'idle' else workflow_state end where id = ${run.conversationId} and organization_id = ${input.organizationId}`);
    await recordEvent(tx, { organizationId: input.organizationId, conversationId: run.conversationId, type: "sequence.completed", actorUserId: null, to: { followUpRunId: input.runId } });
    return { next: null };
  }
  const due = dueAfter(input.from, next.delayMinutes, await organizationTimeZone(input.organizationId, tx));
  const moved = await tx
    .update(followUpStepRuns)
    .set({ status: "scheduled", dueAt: due, updatedAt: input.now })
    .where(and(eq(followUpStepRuns.id, next.id), inArray(followUpStepRuns.status, [...SCHEDULABLE])))
    .returning({ id: followUpStepRuns.id });
  // A writer moved the step off `scheduled` and `failed` after the pick. Neither completing the run nor moving its
  // position would be true, so the throw rolls back the caller's whole transaction (`StepMovedError`).
  if (moved.length === 0) throw new StepMovedError(input.runId);
  await tx.update(followUpRuns).set({ currentStepPosition: next.position, updatedAt: input.now }).where(eq(followUpRuns.id, input.runId));
  await tx.execute(sql`update conversations set next_action_at = ${ts(due)} where id = ${run.conversationId} and organization_id = ${input.organizationId} and workflow_state in ('waiting', 'idle')`);
  return { next: next.position };
}

/**
 * A conversation moved to a reply type whose follow-ups stop: its runs end in the caller's transaction. A run that started at
 * that same type is spared, as in the sweep's rule. The caller's `followUps` (the decision of `decideReplyType`) is
 * the rule. A caller that passes none gets the Follow-ups rule of the conversation's current reply type, read here, so the
 * caller writes the conversation first. No key or group decides.
 */
export async function interruptOnTerminalStageTx(
  tx: Tx,
  input: {
    organizationId: string;
    conversationId: string;
    replyTypeId: string | null;
    followUps?: FollowUpsOutcome;
    now: Date;
  },
): Promise<number> {
  const followUps = input.followUps ?? (await currentFollowUpsTx(tx, input.organizationId, input.conversationId));
  if (followUps !== "stop") return 0;
  return interruptConversationRunsTx(tx, input.organizationId, input.conversationId, "terminal_stage", input.now, input.replyTypeId ?? undefined);
}

/** The Follow-ups rule of the conversation's current reply type, or null when the conversation has none. */
async function currentFollowUpsTx(tx: Tx, organizationId: string, conversationId: string): Promise<FollowUpsRule | null> {
  const [row] = await tx
    .select({ followUps: replyTypes.followUps })
    .from(conversations)
    .innerJoin(replyTypes, and(eq(replyTypes.id, conversations.replyTypeId), eq(replyTypes.organizationId, conversations.organizationId)))
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)));
  return row?.followUps ?? null;
}
