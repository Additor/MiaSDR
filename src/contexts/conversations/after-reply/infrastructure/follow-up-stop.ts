import { and, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { drafts, people, conversations } from "@/platform/db/schema";
import { sqlValues } from "@/platform/db/sql-values";
import { RETIRABLE_DRAFT_STATUSES } from "../../domain/draft-status";
import { ACTIVE_RUN_STATUSES, OPEN_STEP_STATUSES, RUN_FROM, STEP_FROM, type RunStatus, type StepRunStatus } from "../domain/follow-ups";
import { followUpRuns, followUpStepRuns } from "./follow-ups-schema";

/**
 * Ending a follow-up run from inside another write's transaction, so the run stops and its unsent drafts retire in the
 * same commit as the trigger. `stopContactTx` (`stopping/infrastructure/stop-contact.ts`) calls the person and address
 * forms for everything that stops contact. A terminal reply type and a closed conversation end one conversation's runs
 * here. The 60 second sweep stays as a safety net. The conversations core reaches Follow-ups after a reply through this
 * module and, to restart a run, `createRunOn` and `loadStartOn` in drizzle-follow-up-store.ts. Every other file here
 * depends on the core, not the other way.
 *
 * The run files write `conversations` in raw SQL: those writes leave `conversations.updated_at` alone, which a Drizzle update stamps
 * through `$onUpdate`. Their own tables they write with the query builder.
 */

export type Tx = DbTx;

export type StopFinal = "interrupted" | "cancelled";

/** Draft statuses a person has not acted on. A run that ends retires them; a send in flight is left alone. */
export const RETIRABLE_DRAFTS = sqlValues(RETIRABLE_DRAFT_STATUSES);
export const OPEN_STEPS = sqlValues(OPEN_STEP_STATUSES);

/**
 * The statuses a run may become `to` from (`RUN_FROM`). Every update that writes `follow_up_runs.status` filters with it
 * (status-guards.test.ts).
 */
export const runMayBecome = (to: RunStatus) => inArray(followUpRuns.status, [...RUN_FROM[to]]);
/**
 * The statuses a step run may become `to` from (`STEP_FROM`). Every update that writes `follow_up_step_runs.status`
 * filters with it or with a narrower status check (status-guards.test.ts). The claim's lease takeover in `takeDueStep`
 * moves `drafting` to `drafting`, the one move outside the table.
 */
export const stepMayBecome = (to: StepRunStatus) => inArray(followUpStepRuns.status, [...STEP_FROM[to]]);

/** Locks the conversation row: the first lock of every run write, which takes conversation, then run, then step run. */
export const lockConversationTx = (tx: Tx, organizationId: string, conversationId: string) =>
  tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId))).for("no key update");

/**
 * Writes an event of the conversation. It stays raw SQL: it copies the person and context version from the conversation row, and
 * stores an absent `from` or `to` as JSON `null`, where a Drizzle insert writes SQL NULL.
 */
export async function recordEvent(
  tx: Tx,
  input: { organizationId: string; conversationId: string; type: string; actorUserId: string | null; from?: unknown; to?: unknown; meta?: Record<string, unknown> },
) {
  await tx.execute(sql`
    insert into events (organization_id, person_id, conversation_id, event_type, actor_type, actor_user_id, from_data, to_data, meta, context_version)
    select r.organization_id, r.person_id, r.id, ${input.type}, ${input.actorUserId ? "human" : "system"}, ${input.actorUserId}::uuid,
           ${JSON.stringify(input.from ?? null)}::jsonb, ${JSON.stringify(input.to ?? null)}::jsonb, ${JSON.stringify(input.meta ?? {})}::jsonb, r.context_version
    from conversations r where r.id = ${input.conversationId} and r.organization_id = ${input.organizationId}`);
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
  const ofRun = and(eq(followUpRuns.id, input.runId), eq(followUpRuns.organizationId, input.organizationId));
  // Lock order everywhere is conversation, then run. A worker holding the run waits for the conversation, so taking the run first here could deadlock.
  const [peek] = await tx.select({ conversationId: followUpRuns.conversationId }).from(followUpRuns).where(ofRun);
  if (!peek) return null;
  await lockConversationTx(tx, input.organizationId, peek.conversationId);
  const [run] = await tx.select({ conversationId: followUpRuns.conversationId, status: followUpRuns.status }).from(followUpRuns).where(ofRun).for("update");
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
              .select({ id: followUpStepRuns.draftId })
              .from(followUpStepRuns)
              .where(and(eq(followUpStepRuns.followUpRunId, input.runId), isNotNull(followUpStepRuns.draftId), inArray(followUpStepRuns.status, [...OPEN_STEP_STATUSES]))),
          ),
          sql`${drafts.request}->>'followUpRunId' = ${input.runId}`,
        ),
      ),
    )
    .returning({ id: drafts.id });
  await tx
    .update(followUpStepRuns)
    .set({ status: "cancelled", claimToken: null, updatedAt: input.now })
    .where(and(eq(followUpStepRuns.followUpRunId, input.runId), eq(followUpStepRuns.organizationId, input.organizationId), stepMayBecome("cancelled")));
  await tx.update(followUpRuns).set({ status: input.final, updatedAt: input.now }).where(and(eq(followUpRuns.id, input.runId), runMayBecome(input.final)));
  await tx.execute(sql`update conversations set next_action_at = null where id = ${run.conversationId} and organization_id = ${input.organizationId} and workflow_state = 'waiting'`);
  await recordEvent(tx, {
    organizationId: input.organizationId,
    conversationId: run.conversationId,
    type: input.final === "interrupted" ? "sequence.interrupted" : "sequence.cancelled",
    actorUserId: input.actorUserId ?? null,
    from: { followUpRunId: input.runId, status: run.status },
    to: { followUpRunId: input.runId, status: input.final },
    meta: { reason: input.reason },
  });
  return { draftsRetired: retired.length };
}

/** What a stop ended: the runs, and the unsent drafts the same statements retired. */
export interface RunStop {
  runs: number;
  drafts: number;
}

async function interruptRuns(tx: Tx, organizationId: string, runIds: string[], reason: string, now: Date): Promise<RunStop> {
  const stopped: RunStop = { runs: 0, drafts: 0 };
  for (const runId of runIds) {
    const ended = await endRunCountingTx(tx, { organizationId, runId, final: "interrupted", reason, now });
    if (!ended) continue;
    stopped.runs += 1;
    stopped.drafts += ended.draftsRetired;
  }
  return stopped;
}

/**
 * Ends every active or paused run of one conversation. `exceptReplyTypeId` spares a run that started at that
 * reply type, so a run started on a terminal reply type is not ended by its own start.
 */
export async function interruptConversationRunsTx(tx: Tx, organizationId: string, conversationId: string, reason: string, now: Date, exceptReplyTypeId?: string): Promise<number> {
  const runs = await tx
    .select({ id: followUpRuns.id })
    .from(followUpRuns)
    .where(
      and(
        eq(followUpRuns.organizationId, organizationId),
        eq(followUpRuns.conversationId, conversationId),
        inArray(followUpRuns.status, [...ACTIVE_RUN_STATUSES]),
        exceptReplyTypeId ? ne(followUpRuns.replyTypeId, exceptReplyTypeId) : undefined,
      ),
    )
    .orderBy(followUpRuns.id);
  return (await interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now)).runs;
}

/** The ids of the live runs whose conversation matches `where`, in id order. Every join stays inside the organization. */
const liveRunsOf = (tx: Tx, organizationId: string, where: SQL) =>
  tx
    .select({ id: followUpRuns.id })
    .from(followUpRuns)
    .innerJoin(conversations, and(eq(conversations.id, followUpRuns.conversationId), eq(conversations.organizationId, followUpRuns.organizationId)))
    .innerJoin(people, and(eq(people.id, conversations.personId), eq(people.organizationId, followUpRuns.organizationId)))
    .where(and(eq(followUpRuns.organizationId, organizationId), inArray(followUpRuns.status, [...ACTIVE_RUN_STATUSES]), where))
    .orderBy(followUpRuns.id);

/** Ends the runs of every conversation of the given people. */
export async function interruptPersonRunsTx(tx: Tx, organizationId: string, personIds: readonly string[], reason: string, now: Date): Promise<RunStop> {
  if (personIds.length === 0) return { runs: 0, drafts: 0 };
  const runs = await liveRunsOf(tx, organizationId, inArray(conversations.personId, [...personIds]));
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

/** Ends the runs of every person in the organization with this address (case-insensitive). */
export async function interruptEmailRunsTx(tx: Tx, organizationId: string, email: string, reason: string, now: Date): Promise<RunStop> {
  const runs = await liveRunsOf(tx, organizationId, sql`lower(${people.email}) = ${email.trim().toLowerCase()}`);
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}
