import { and, eq, sql } from "drizzle-orm";
import { startRun } from "../after-reply/application/sequences";
import { createRunOn, loadStartOn } from "../after-reply/infrastructure/drizzle-sequence-store";
import type { DbTx as Tx } from "@/platform/db/client";
import { aiJobs } from "@/platform/db/schema";
import { rowsOf } from "@/platform/db/sql-values";
import { interruptRecordRunsTx } from "../after-reply/infrastructure/sequence-stop";
import { decideReplyType, type ReplyTypeDecision, type ReplyType, type FollowUpsOutcome } from "../domain/reply-type";
import { staleOpenDraftsTx } from "./stale-drafts-sql";
import { followUpModeFactsTx } from "./follow-up-mode-facts";
import { replyAskedToStop } from "./stop-requested-sql";

/**
 * A person changed what the record is: a type change off the thread, or their own pick for the latest reply. Work that
 * was prepared for the old type ends in the same transaction, and the owning campaign's flow starts from the new one.
 *
 * 1. Open drafts retire (`stale`), so nobody sends a reply written for the old type.
 * 2. The active or paused sequence run ends as `interrupted` with `reason`.
 * 3. An AI pick held for a check retires (`stale`), so Actions, the history and the reply counts stop showing it as waiting.
 * 4. `context_version` goes up by one, so draft and classification jobs queued for the old version skip.
 * 5. A new run starts only when the person's decision says follow-ups keep going (`followUps` of `decideReplyType`)
 *    and the campaign that most recently emailed the person has Follow-ups after a reply on; otherwise no run starts.
 *
 * The caller holds the record's lock and has already written the new type. Undo only ends work, so it calls
 * `interruptRecordRunsTx` and retires drafts itself.
 */
export type RestartReason = "stage_moved" | "classification_corrected";

export interface RestartResult {
  contextVersion: number;
  draftsRetired: number;
  runsEnded: number;
  runStarted: boolean;
}

export async function restartRecordWorkTx(
  tx: Tx,
  input: { organizationId: string; recordId: string; reason: RestartReason; draftReason: string; followUps: FollowUpsOutcome; now: Date; actorUserId: string },
): Promise<RestartResult> {
  const draftsRetired = await staleOpenDraftsTx(tx, { organizationId: input.organizationId, recordId: input.recordId, reason: input.draftReason, now: input.now });
  const runsEnded = await interruptRecordRunsTx(tx, input.organizationId, input.recordId, input.reason, input.now);
  // A held AI pick can no longer be accepted once the version goes up. A person's own pick settled it before this call.
  await tx.execute(sql`
    update reply_type_picks set status = 'stale'
    where organization_id = ${input.organizationId} and record_id = ${input.recordId} and status = 'proposed'`);
  const [bumped] = rowsOf<{ context_version: number }>(
    await tx.execute(sql`update records set context_version = context_version + 1 where id = ${input.recordId} and organization_id = ${input.organizationId} returning context_version`),
  );
  if (input.followUps !== "continue") return { contextVersion: bumped.context_version, draftsRetired, runsEnded, runStarted: false };

  // The same code that starts a run for a new reply, bound to this transaction, so a failed start rolls the change back.
  const started = await startRun(
    {
      now: () => input.now,
      runs: {
        loadStart: (organizationId, recordId, opts) => loadStartOn(tx, organizationId, recordId, opts),
        createRun: (run) => createRunOn(tx, run),
      },
    },
    { organizationId: input.organizationId, recordId: input.recordId, source: "ai_assignment", actorUserId: input.actorUserId },
  );
  return { contextVersion: bumped.context_version, draftsRetired, runsEnded, runStarted: Boolean(started?.created) };
}

/**
 * What a person's choice of `target` means for `record`, read inside the caller's transaction after it locked the record
 * and before it writes the new type. The caller locked the record through a visibility rule, so a record with only
 * private conversations never gets here. A person's pick has no confidence, so it never holds, and the floor, the lock
 * and the current type play no part.
 */
export async function personTypeDecisionTx(
  tx: Tx,
  input: { organizationId: string; record: { id: string; latestInboundMessageId: string | null; replyTypeLocked: boolean }; target: Pick<ReplyType, "groupKey" | "rules"> },
): Promise<ReplyTypeDecision & { stopRequested: boolean }> {
  const { organizationId, record, target } = input;
  const stopRequested = await replyAskedToStop(tx, record.latestInboundMessageId);
  const mode = await followUpModeFactsTx(tx, organizationId, record.id);
  const decision = decideReplyType(target, {
    stopRequested,
    isContact: mode?.isContact ?? false,
    campaignMode: mode?.campaignMode ?? null,
    channel: mode?.channel ?? null,
    confidence: null,
    floor: 1,
    locked: record.replyTypeLocked,
    currentType: null,
  });
  return { ...decision, stopRequested };
}

/**
 * Queues the initial draft for a pick at `contextVersion`. One draft job exists per pick (unique on kind and entity): a
 * job that already finished for an earlier version goes back to the queue under a key for this version, and a queued job
 * stays and picks up the new version. A running job read the old version, so its draft goes in stale: it is marked
 * `rerun`, and the job store puts it back in the queue when that run ends (`complete`, `fail`). True when a job now
 * waits, or runs and will run again.
 */
export async function queuePickDraftTx(tx: Tx, input: { organizationId: string; replyTypePickId: string; contextVersion: number }): Promise<boolean> {
  const key = `initial_draft:classification:${input.replyTypePickId}:v${input.contextVersion}`;
  await tx
    .insert(aiJobs)
    .values({ organizationId: input.organizationId, kind: "initial_draft", entityType: "classification", entityId: input.replyTypePickId, idempotencyKey: key, runAfter: sql`now() - interval '1 minute'`, payload: { humanInitiated: true } })
    .onConflictDoUpdate({
      target: [aiJobs.kind, aiJobs.entityType, aiJobs.entityId],
      set: { status: "queued", attempts: 0, runAfter: sql`now() - interval '1 minute'`, idempotencyKey: key, payload: sql`${aiJobs.payload} || '{"humanInitiated":true}'::jsonb`, completedAt: null, failedAt: null, lastError: null, lockedAt: null, lockedBy: null, claimToken: null },
      setWhere: sql`${aiJobs.status} in ('succeeded', 'failed', 'skipped')`,
    });
  const [job] = await tx
    .update(aiJobs)
    .set({ payload: sql`${aiJobs.payload} || jsonb_build_object('rerun', true, 'humanInitiated', true)` })
    .where(and(eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityType, "classification"), eq(aiJobs.entityId, input.replyTypePickId), eq(aiJobs.status, "running")))
    .returning({ status: aiJobs.status });
  if (job) return true;
  const [queued] = await tx.select({ status: aiJobs.status }).from(aiJobs).where(and(eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityType, "classification"), eq(aiJobs.entityId, input.replyTypePickId)));
  return queued?.status === "queued";
}
