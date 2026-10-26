import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { lockPersonOutreachTx } from "@/platform/db/person-locks";
import { rowsOf, sqlValues } from "@/platform/db/sql-values";
import { stopEnrollmentsOnReplyTx } from "@/contexts/outreach/infrastructure/reply-stop";
import { RETIRABLE_DRAFT_STATUSES } from "../../domain/draft-status";
import type { FollowUpStop } from "@/contexts/outreach/application/inbound-ports";

/**
 * Ending a follow-up sequence run from inside another write's transaction. Every path that makes further contact
 * wrong (do not contact, unsubscribe, bounce, manual suppression, a terminal stage, a closed record, a reply)
 * calls one of these in the transaction that records the trigger, so the run stops and its unsent drafts retire
 * in the same commit. The 60 second sweep stays as a safety net. Conversations owns the runs, so outreach, a lower
 * layer, reaches `interruptEmailRunsTx` through its `FollowUpStop` port, which src/composition wires to this module.
 * The conversations core reaches After a reply through this module and, to restart a run, `createRunOn` and
 * `loadStartOn` in drizzle-sequence-store.ts. Every other file here depends on the core, not the other way.
 */

export type Tx = DbTx;

export type StopFinal = "interrupted" | "cancelled";

const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;
/** Draft statuses a person has not acted on. A run that ends retires them; a send in flight is left alone. */
export const RETIRABLE_DRAFTS = sqlValues(RETIRABLE_DRAFT_STATUSES);
export const OPEN_STEPS = sql`('scheduled', 'drafting', 'awaiting_review', 'failed')`;

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
  // Lock order everywhere is record, then run. A worker holding the run waits for the record, so taking the run first here could deadlock.
  const [peek] = rowsOf<{ record_id: string }>(await tx.execute(sql`select record_id from sequence_runs where id = ${input.runId} and organization_id = ${input.organizationId}`));
  if (!peek) return null;
  await tx.execute(sql`select id from records where id = ${peek.record_id} and organization_id = ${input.organizationId} for update`);
  const [run] = rowsOf<{ id: string; record_id: string; status: string }>(
    await tx.execute(sql`select id, record_id, status from sequence_runs where id = ${input.runId} and organization_id = ${input.organizationId} for update`),
  );
  if (!run || (run.status !== "active" && run.status !== "paused")) return null;
  const retired = rowsOf<{ id: string }>(await tx.execute(sql`
    update drafts set status = 'stale', error = 'The follow-up sequence ended.', updated_at = ${ts(input.now)}
    where organization_id = ${input.organizationId} and status in ${RETIRABLE_DRAFTS}
      and (id in (select draft_id from sequence_step_runs where sequence_run_id = ${input.runId} and draft_id is not null and status in ${OPEN_STEPS})
           or request->>'sequenceRunId' = ${input.runId})
    returning id`));
  await tx.execute(sql`
    update sequence_step_runs set status = 'cancelled', updated_at = ${ts(input.now)}
    where sequence_run_id = ${input.runId} and organization_id = ${input.organizationId} and status in ${OPEN_STEPS}`);
  await tx.execute(sql`update sequence_runs set status = ${input.final}, updated_at = ${ts(input.now)} where id = ${input.runId}`);
  await tx.execute(sql`update records set next_action_at = null where id = ${run.record_id} and organization_id = ${input.organizationId} and workflow_state = 'waiting'`);
  await recordEvent(tx, {
    organizationId: input.organizationId,
    recordId: run.record_id,
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
 * Ends every active or paused run of one record. `exceptSubcategoryId` spares a run that started at that
 * subcategory, so a sequence assigned to a terminal subcategory is not cancelled by its own start.
 */
export async function interruptRecordRunsTx(tx: Tx, organizationId: string, recordId: string, reason: string, now: Date, exceptSubcategoryId?: string): Promise<number> {
  const runs = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from sequence_runs
      where organization_id = ${organizationId} and record_id = ${recordId} and status in ('active', 'paused')
        ${exceptSubcategoryId ? sql`and subcategory_id <> ${exceptSubcategoryId}` : sql``}
      order by id`),
  );
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

/** Ends the runs of every record of the given people. */
export async function interruptPersonRunsTx(tx: Tx, organizationId: string, personIds: string[], reason: string, now: Date): Promise<number> {
  if (personIds.length === 0) return 0;
  const ids = sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `);
  const runs = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select r.id from sequence_runs r join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
      where r.organization_id = ${organizationId} and rec.person_id in (${ids}) and r.status in ('active', 'paused')
      order by r.id`),
  );
  return interruptRuns(tx, organizationId, runs.map((r) => r.id), reason, now);
}

/** Ends the runs of every person in the organization with this address (case-insensitive). */
export async function interruptEmailRunsTx(tx: Tx, organizationId: string, email: string, reason: string, now: Date): Promise<number> {
  const runs = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select r.id from sequence_runs r
      join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
      join people p on p.id = rec.person_id and p.organization_id = r.organization_id
      where r.organization_id = ${organizationId} and lower(p.email) = ${email.trim().toLowerCase()} and r.status in ('active', 'paused')
      order by r.id`),
  );
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
  const people = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from people
      where organization_id = ${input.organizationId}
        and (id = ${input.personId}::uuid ${sender ? sql`or lower(email) = ${sender}` : sql``})
      order by id`),
  );
  const personIds = people.map((p) => p.id);
  if (personIds.length === 0) return { enrollmentsStopped: 0, runsEnded: 0 };
  // Same lock as a restore of a removed lead (drizzle-enrollment-restore): one of the two commits first and the other sees it.
  await lockPersonOutreachTx(tx, input.organizationId, personIds);

  const stopped = await stopEnrollmentsOnReplyTx(tx, input.organizationId, personIds, input.now);
  const runsEnded = await interruptPersonRunsTx(tx, input.organizationId, personIds, "reply", input.now);

  for (const personId of new Set(stopped.map((e) => e.person_id))) {
    const own = stopped.filter((e) => e.person_id === personId);
    await tx.execute(sql`
      insert into events (organization_id, person_id, event_type, actor_type, to_data, meta)
      values (${input.organizationId}, ${personId}::uuid, 'outreach.stopped_by_reply', 'system',
              ${JSON.stringify({ status: "replied" })}::jsonb,
              ${JSON.stringify({ replyChannel: input.channel, enrollmentIds: own.map((e) => e.id), channels: [...new Set(own.map((e) => e.channel))] })}::jsonb)`);
  }
  return { enrollmentsStopped: stopped.length, runsEnded };
}

/** Outreach's view of these runs: src/composition hands it to outreach's suppression store. */
export const followUpStop: FollowUpStop = { endEmailRunsTx: interruptEmailRunsTx };
