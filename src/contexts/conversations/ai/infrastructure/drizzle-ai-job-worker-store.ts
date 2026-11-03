import { and, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { heldBy, NEW_CLAIM_TOKEN } from "@/platform/db/claim";
import { interruptOnStoppingTypeTx } from "../../after-reply/infrastructure/follow-up-run-tx";
import { aiJobs, replyTypePicks, threads, events, messages, conversations, replyTypes } from "@/platform/db/schema";
import type { AiJobWorkerStore, ClaimedJob, JobKind } from "../../application/reply-ports";
import { AUTO_REQUEUE_CEILING, type FailureKind } from "../domain/ai-job-requeue";
import { readUnknownSenderAiCap, UNKNOWN_SENDER_AI_CAP_KEY } from "@/contexts/tenancy/domain/ai-cap";
import { startOfLocalDay } from "@/contexts/outreach/domain/working-hours";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { settlesAfterAiPick } from "../../domain/workflow-state";
import { decideReplyType, typeRulesOf, type ReplyTypeFacts } from "../../domain/reply-type";
import { followUpModeFactsTx } from "../../infrastructure/follow-up-mode-facts";
import { insertDraftTx } from "../../infrastructure/reply-store-drafts";
import type { Tx } from "../../after-reply/infrastructure/follow-up-stop";
import { SEND_COUNTED } from "@/contexts/outreach/domain/send-status";
import { sqlValues } from "@/platform/db/sql-values";

/**
 * The facts of `decideReplyType` that the classify context does not carry, read in the apply transaction: whether
 * follow-ups apply (`followUpModeFactsTx`, as a person's type change reads them).
 */
async function applyFactsTx(
  tx: Tx,
  organizationId: string,
  conversation: { id: string; activeChannel: string | null },
): Promise<Pick<ReplyTypeFacts, "isContact" | "campaignMode" | "channel">> {
  const mode = await followUpModeFactsTx(tx, organizationId, conversation.id);
  return {
    isContact: mode?.isContact ?? false,
    campaignMode: mode?.campaignMode ?? null,
    channel: mode?.channel ?? conversation.activeChannel,
  };
}

interface JobRow {
  id: string;
  organization_id: string;
  kind: JobKind;
  entity_id: string;
  attempts: number;
  max_attempts: number;
  claim_token: string;
}

const toClaimed = (r: JobRow): ClaimedJob => ({
  id: r.id,
  organizationId: r.organization_id,
  kind: r.kind,
  entityId: r.entity_id,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  claimToken: r.claim_token,
});

/**
 * New work is due immediately. The claim compares `run_after` with the worker's clock, so a database clock a few
 * milliseconds ahead of the worker would hide a fresh job for a moment. A minute in the past avoids that.
 */
export const DUE_NOW = sql`now() - interval '1 minute'`;

/** Ends the lease. The token goes too, so no later statement matches this claim. */
const UNLOCK = { lockedAt: null, lockedBy: null, claimToken: null } as const;

/**
 * A draft job a person's pick marked while it ran (`queuePickDraftTx`): the run read an old version, so when it ends the
 * job goes back to the queue with fresh attempts instead of finishing. One statement per row, so a mark that commits
 * while the run ends is not lost.
 */
const RERUN = sql`(${aiJobs.payload} ? 'rerun')`;
const endOrRerun = (end: { status: "succeeded" | "failed"; at: Date }) => ({
  status: sql`case when ${RERUN} then 'queued' else ${end.status} end`,
  attempts: sql`case when ${RERUN} then 0 else ${aiJobs.attempts} end`,
  runAfter: sql`case when ${RERUN} then ${DUE_NOW} else ${aiJobs.runAfter} end`,
  ...(end.status === "succeeded"
    ? { completedAt: sql`case when ${RERUN} then null else ${end.at.toISOString()}::timestamptz end` }
    : { failedAt: sql`case when ${RERUN} then null else ${end.at.toISOString()}::timestamptz end` }),
});

/**
 * The claim this worker still holds. A claim writes a fresh token, so a job reclaimed after its lease ran out, or
 * requeued and claimed again, carries another one, and the first worker's late settle matches nothing.
 */
const heldClaim = (job: ClaimedJob) => and(eq(aiJobs.id, job.id), eq(aiJobs.status, "running"), heldBy("ai_jobs", job));

/** Locks the job row while this worker holds the claim, so a reclaim waits until the result is written. False when it does not. */
async function holdsClaimTx(tx: Tx, job: ClaimedJob): Promise<boolean> {
  const [row] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(heldClaim(job)).for("update");
  return row !== undefined;
}

/** Stores why a job failed, and the requeue ceiling the first time it fails, in the job's own payload. */
const failureMarks = (kind: FailureKind) =>
  sql`${aiJobs.payload} || jsonb_build_object('failureKind', ${kind}::text, 'requeueCeiling', coalesce(${aiJobs.payload}->'requeueCeiling', to_jsonb(${AUTO_REQUEUE_CEILING}::int)))`;

/**
 * Whether the organization ever wrote to the sender of message `m`: an outbound message to the address or in another
 * conversation of the same conversation (LinkedIn has no address), or a campaign send to a person with that address.
 */
const senderKnown = (alias: string) => {
  const m = sql.raw(alias);
  return sql`(
  exists (select 1 from messages o where o.organization_id = ${m}.organization_id and o.direction = 'outbound' and lower(o.to_address) = lower(${m}.from_address))
  or exists (select 1 from messages o join threads oc on oc.id = o.thread_id join threads mc on mc.conversation_id = oc.conversation_id
             where mc.id = ${m}.thread_id and o.organization_id = ${m}.organization_id and o.direction = 'outbound')
  or exists (select 1 from sends s join campaign_enrollments e on e.id = s.enrollment_id join people p on p.id = e.person_id
             where s.organization_id = ${m}.organization_id and s.status in ${sqlValues(SEND_COUNTED)} and lower(p.email) = lower(${m}.from_address))
)`;
};

/** The AI worker's claim and every method that ends it or writes its result. Each one filters with `heldBy`. */
export const drizzleAiJobWorkerStore: AiJobWorkerStore = {
  async claim(kind, workerId, now, leaseMs) {
    const expired = new Date(now.getTime() - leaseMs);
    // A job whose lease ran out on its last attempt is finished, not re-run, unless a person's pick asked for a rerun.
    await db
      .update(aiJobs)
      .set({ ...endOrRerun({ status: "failed", at: now }), lastError: "The worker stopped during the last attempt.", payload: sql`case when ${RERUN} then ${aiJobs.payload} - 'rerun' else ${failureMarks("lease")} end`, ...UNLOCK })
      .where(and(eq(aiJobs.kind, kind), eq(aiJobs.status, "running"), sql`${aiJobs.lockedAt} < ${expired.toISOString()}::timestamptz`, sql`${aiJobs.attempts} >= ${aiJobs.maxAttempts}`));
    const rows = (await db.execute(sql`
      with candidate as (
        select id from ai_jobs
        where kind = ${kind}
          and attempts < max_attempts
          and ((status = 'queued' and run_after <= ${now.toISOString()}::timestamptz)
            or (status = 'running' and locked_at < ${expired.toISOString()}::timestamptz))
        order by priority desc, run_after, created_at
        limit 1
        for update skip locked
      )
      update ai_jobs j
      set status = 'running', locked_at = ${now.toISOString()}::timestamptz, locked_by = ${workerId},
          started_at = ${now.toISOString()}::timestamptz, attempts = j.attempts + 1, claim_token = ${NEW_CLAIM_TOKEN}
      from candidate
      where j.id = candidate.id
      returning j.id, j.organization_id, j.kind, j.entity_id, j.attempts, j.max_attempts, j.claim_token
    `)) as unknown as JobRow[];
    return rows[0] ? toClaimed(rows[0]) : null;
  },

  async complete(job, now) {
    await db
      .update(aiJobs)
      .set({ ...endOrRerun({ status: "succeeded", at: now }), payload: sql`${aiJobs.payload} - 'rerun'`, lastError: null, ...UNLOCK })
      .where(heldClaim(job));
  },

  async release(job, runAfter) {
    await db
      .update(aiJobs)
      .set({ status: "queued", runAfter, attempts: sql`greatest(${aiJobs.attempts} - 1, 0)`, ...UNLOCK })
      .where(heldClaim(job));
  },

  async retry(job, error, runAfter) {
    // The retry reads the context again, so a rerun mark is spent.
    await db.update(aiJobs).set({ status: "queued", runAfter, lastError: error.slice(0, 1000) || "retry", payload: sql`${aiJobs.payload} - 'rerun'`, ...UNLOCK }).where(heldClaim(job));
  },

  async fail(job, error, now, failureKind = "transient") {
    const lastError = error.slice(0, 1000) || "failed";
    await db.transaction(async (tx) => {
      // A classification failure writes a pick and an event of the conversation, so it locks the conversation before the job row,
      // the order `finishClassification` takes them in. The other order deadlocks with a late worker's classification.
      const [conversation] =
        job.kind === "classification"
          ? await tx
              .select({ id: conversations.id, personId: conversations.personId, version: conversations.contextVersion })
              .from(messages)
              .innerJoin(threads, eq(threads.id, messages.threadId))
              .innerJoin(conversations, eq(conversations.id, threads.conversationId))
              .where(and(eq(messages.id, job.entityId), eq(messages.organizationId, job.organizationId)))
              .for("no key update", { of: conversations })
          : [];
      const moved = await tx
        .update(aiJobs)
        .set({ ...endOrRerun({ status: "failed", at: now }), lastError, payload: sql`case when ${RERUN} then ${aiJobs.payload} - 'rerun' else ${failureMarks(failureKind)} end`, ...UNLOCK })
        .where(heldClaim(job))
        .returning({ id: aiJobs.id, status: aiJobs.status });
      if (moved.length === 0 || moved[0].status !== "failed" || job.kind !== "classification") return;
      if (!conversation) return;
      // Recorded so the panel can say why, and so the sweep does not queue the same message again.
      await tx
        .insert(replyTypePicks)
        .values({ organizationId: job.organizationId, conversationId: conversation.id, messageId: job.entityId, expectedContextVersion: conversation.version, status: "failed", error: lastError })
        .onConflictDoNothing();
      await tx.insert(events).values({
        organizationId: job.organizationId,
        personId: conversation.personId,
        conversationId: conversation.id,
        eventType: "reply_type_pick.failed",
        actorType: "ai",
        meta: { error: lastError },
        contextVersion: conversation.version,
      });
    });
  },

  async skipOverCap(job, now) {
    // A person asked for this job (a correction that queues a draft), so the unknown-sender cap does not apply.
    const [own] = await db.select({ payload: aiJobs.payload }).from(aiJobs).where(eq(aiJobs.id, job.id));
    if ((own?.payload as { humanInitiated?: boolean } | null)?.humanInitiated) return false;
    const [general] = await db.execute(sql`select "values" as v from channel_settings where organization_id = ${job.organizationId} and channel = 'general'`) as unknown as Array<{ v: Record<string, unknown> }>;
    const cap = readUnknownSenderAiCap(general?.v?.[UNKNOWN_SENDER_AI_CAP_KEY]);
    const zone = await organizationTimeZone(job.organizationId);
    const dayStart = startOfLocalDay(now, zone);
    // The cap counts replies, not jobs: a message's classification and its draft use one place. Jobs rank by
    // (started_at, id), so a concurrent pair sees each other in a fixed order and no lock is needed. Skipped jobs
    // drop out of the count, so every reply after the limit sees the same number and is skipped too.
    const [row] = (await db.execute(sql`
      with me as (
        select j.id, j.started_at, m.id as message_id, ${senderKnown("m")} as known
        from ai_jobs j
        left join reply_type_picks c on j.kind = 'initial_draft' and c.id = j.entity_id
        join messages m on m.id = case when j.kind = 'classification' then j.entity_id else c.message_id end
        where j.id = ${job.id}
      ),
      earlier as (
        select distinct m.id as message_id
        from ai_jobs j
        left join reply_type_picks c on j.kind = 'initial_draft' and c.id = j.entity_id
        join messages m on m.id = case when j.kind = 'classification' then j.entity_id else c.message_id end
        join me on true
        where j.organization_id = ${job.organizationId}
          and j.status in ('running', 'succeeded', 'failed')
          and j.started_at >= ${dayStart.toISOString()}::timestamptz
          and (j.started_at, j.id) < (me.started_at, me.id)
          and not ${senderKnown("m")}
      )
      select me.known as known,
             exists (select 1 from earlier e where e.message_id = me.message_id) as admitted,
             (select count(*)::int from earlier e where e.message_id <> me.message_id) as ahead
      from me
    `)) as unknown as Array<{ known: boolean; admitted: boolean; ahead: number }>;
    if (!row || row.known || row.admitted || row.ahead < cap) return false;
    const detail = `The organization's limit of ${cap} AI jobs a day for senders it never wrote to is used up.`;
    const done = await db
      .update(aiJobs)
      .set({
        status: "skipped",
        completedAt: now,
        lastError: detail,
        payload: sql`${aiJobs.payload} || ${JSON.stringify({ skipReason: "daily_cap", cap })}::jsonb`,
        ...UNLOCK,
      })
      .where(heldClaim(job))
      .returning({ id: aiJobs.id });
    return done.length > 0;
  },

  async finishClassification(input) {
    return db.transaction(async (tx) => {
      // The conversation lock comes first, as in a person's pick that marks or requeues the job (`queuePickDraftTx`).
      const [conversation] = await tx
        .select({
          id: conversations.id,
          personId: conversations.personId,
          replyTypeSetId: conversations.replyTypeSetId,
          version: conversations.contextVersion,
          latest: conversations.latestInboundMessageId,
          groupKey: conversations.groupKey,
          replyTypeId: conversations.replyTypeId,
          locked: conversations.replyTypeLocked,
          activeChannel: conversations.activeChannel,
          state: conversations.workflowState,
        })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(conversations, eq(conversations.id, threads.conversationId))
        .where(and(eq(messages.id, input.messageId), eq(messages.organizationId, input.job.organizationId)))
        .for("no key update", { of: conversations });
      if (!conversation) return { status: "stale" as const };
      // A worker whose lease ran out writes nothing: the job's current claim owns this result.
      if (!(await holdsClaimTx(tx, input.job))) return { status: "stale" as const };
      const [proposed] = await tx
        .select()
        .from(replyTypes)
        .where(and(eq(replyTypes.replyTypeSetId, conversation.replyTypeSetId), eq(replyTypes.key, input.proposedReplyTypeKey)));

      const base = {
        rules: proposed ? typeRulesOf(proposed) : null,
        organizationId: input.job.organizationId,
        conversationId: conversation.id,
        messageId: input.messageId,
        expectedContextVersion: input.expectedContextVersion,
        previousGroupKey: conversation.groupKey,
        previousReplyTypeId: conversation.replyTypeId,
        proposedGroupKey: proposed?.groupKey ?? null,
        proposedReplyTypeId: proposed?.id ?? null,
        confidence: input.confidence.toFixed(4),
        reasoning: input.reason,
        provider: input.provider,
        model: input.model,
        request: input.request,
      };

      // A newer reply or a person's decision since the work started: this result must not overwrite it.
      if (conversation.version !== input.expectedContextVersion || conversation.latest !== input.messageId || !proposed) {
        await tx
          .insert(replyTypePicks)
          .values({ ...base, status: "stale", response: input.response })
          .onConflictDoNothing();
        return { status: "stale" as const };
      }

      // The one decision for this pick, under the conversation lock and with the facts as they are now: a lock set after
      // the job read its context holds the pick here.
      const decision = decideReplyType(
        { groupKey: proposed.groupKey, systemRole: proposed.systemRole, rules: typeRulesOf(proposed) },
        {
          ...(await applyFactsTx(tx, input.job.organizationId, conversation)),
          stopRequested: input.stopRequested,
          confidence: input.confidence,
          locked: conversation.locked,
          currentType: { groupKey: conversation.groupKey },
        },
      );
      const auto = decision.hold === null;
      const [row] = await tx
        .insert(replyTypePicks)
        .values({
          ...base,
          status: auto ? "auto_applied" : "proposed",
          appliedGroupKey: auto ? proposed.groupKey : null,
          appliedReplyTypeId: auto ? proposed.id : null,
          response: { ...(input.response as object), holdReason: decision.hold, stopRequested: input.stopRequested, previousLocked: conversation.locked },
        })
        .onConflictDoNothing()
        .returning({ id: replyTypePicks.id });
      // Someone (a person, or another worker) already settled this message at this context version.
      if (!row) return { status: "stale" as const };

      if (auto) {
        const settle = settlesAfterAiPick(conversation.state, decision, input.stopRequested);
        await tx
          .update(conversations)
          .set({
            groupKey: proposed.groupKey,
            replyTypeId: proposed.id,
            replyTypeSource: "ai",
            ...(settle ? { workflowState: "idle" } : {}),
          })
          .where(eq(conversations.id, conversation.id));
        await interruptOnStoppingTypeTx(tx, {
          organizationId: input.job.organizationId,
          conversationId: conversation.id,
          replyTypeId: proposed.id,
          followUps: decision.followUps,
          now: new Date(),
        });
        if (decision.wantsDraft) {
          await tx
            .insert(aiJobs)
            .values({ organizationId: input.job.organizationId, kind: "initial_draft", entityType: "classification", entityId: row.id, idempotencyKey: `initial_draft:classification:${row.id}`, runAfter: sql`now() - interval '1 minute'` })
            .onConflictDoNothing();
        }
      }
      await tx.insert(events).values({
        organizationId: input.job.organizationId,
        personId: conversation.personId,
        conversationId: conversation.id,
        eventType: auto ? "reply_type_pick.applied" : "reply_type_pick.proposed",
        actorType: "ai",
        fromData: { groupKey: conversation.groupKey, replyTypeId: conversation.replyTypeId },
        toData: { groupKey: proposed.groupKey, replyTypeId: proposed.id },
        meta: { confidence: input.confidence, holdReason: decision.hold, stopRequested: input.stopRequested },
        contextVersion: input.expectedContextVersion,
      });
      return { status: auto ? ("auto_applied" as const) : ("proposed" as const) };
    });
  },

  insertDraft(job, draft) {
    // `insertDraftTx` locks the conversation first and then asks for the job row, the order a person's pick takes them in.
    return db.transaction((tx) => insertDraftTx(tx, draft, (locked) => holdsClaimTx(locked, job)));
  },
};
