import { and, eq, sql } from "drizzle-orm";
import { startRun } from "../after-reply/application/follow-ups";
import { createRunOn, loadStartOn } from "../after-reply/infrastructure/drizzle-follow-up-store";
import type { DbTx as Tx } from "@/platform/db/client";
import { aiJobs } from "@/platform/db/schema";
import { decideReplyType, type ReplyTypeDecision, type ReplyType, type FollowUpsOutcome } from "../domain/reply-type";
import { advanceConversationContextTx } from "./conversation-context";
import { followUpModeFactsTx } from "./follow-up-mode-facts";
import { replyAskedToStop } from "./stop-requested-sql";

/**
 * A person changed what the conversation is: a type change off the thread, or their own pick for the latest reply. Work that
 * was prepared for the old type ends in the same transaction, and the owning campaign's flow starts from the new one.
 *
 * 1. `advanceConversationContextTx` bumps the version, retires open drafts and any AI pick held for a check, and ends the active
 *    or paused sequence run as `interrupted` with `reason`.
 * 2. A new run starts only when the person's decision says follow-ups keep going (`followUps` of `decideReplyType`)
 *    and the campaign that most recently emailed the person has Follow-ups after a reply on; otherwise no run starts.
 *
 * The caller holds the conversation's lock and has already written the new type.
 */
export type RestartReason = "type_changed" | "type_corrected";

export interface RestartResult {
  contextVersion: number;
  draftsRetired: number;
  runsEnded: number;
  runStarted: boolean;
}

export async function restartConversationWorkTx(
  tx: Tx,
  input: { organizationId: string; conversationId: string; reason: RestartReason; draftReason: string; followUps: FollowUpsOutcome; now: Date; actorUserId: string },
): Promise<RestartResult> {
  const { contextVersion, draftsRetired, runsEnded } = await advanceConversationContextTx(tx, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    now: input.now,
    drafts: { reason: input.draftReason },
    runs: input.reason,
  });
  if (input.followUps !== "continue") return { contextVersion, draftsRetired, runsEnded, runStarted: false };

  // The same code that starts a run for a new reply, bound to this transaction, so a failed start rolls the change back.
  const started = await startRun(
    {
      now: () => input.now,
      runs: {
        loadStart: (organizationId, conversationId, opts) => loadStartOn(tx, organizationId, conversationId, opts),
        createRun: (run) => createRunOn(tx, run),
      },
    },
    { organizationId: input.organizationId, conversationId: input.conversationId, source: "ai_assignment", actorUserId: input.actorUserId },
  );
  return { contextVersion, draftsRetired, runsEnded, runStarted: Boolean(started?.created) };
}

/**
 * What a person's choice of `target` means for `conversation`, read inside the caller's transaction after it locked the conversation
 * and before it writes the new type. A person's pick has no confidence, so it never holds, and the lock and the current
 * type play no part.
 */
export async function personTypeDecisionTx(
  tx: Tx,
  input: { organizationId: string; conversation: { id: string; latestInboundMessageId: string | null; replyTypeLocked: boolean }; target: Pick<ReplyType, "groupKey" | "rules" | "systemRole"> },
): Promise<ReplyTypeDecision & { stopRequested: boolean }> {
  const { organizationId, conversation, target } = input;
  const stopRequested = await replyAskedToStop(tx, conversation.latestInboundMessageId);
  const mode = await followUpModeFactsTx(tx, organizationId, conversation.id);
  const decision = decideReplyType(target, {
    stopRequested,
    isContact: mode?.isContact ?? false,
    campaignMode: mode?.campaignMode ?? null,
    channel: mode?.channel ?? null,
    confidence: null,
    locked: conversation.replyTypeLocked,
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
