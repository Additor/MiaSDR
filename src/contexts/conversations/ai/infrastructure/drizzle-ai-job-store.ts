import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { interruptOnTerminalStageTx } from "../../after-reply/infrastructure/sequence-run-tx";
import { aiJobs, replyTypePicks, conversations, drafts, events, messages, replyHandlingSettings, records, replyTypes, suppressionList, contactPolicies, people } from "@/platform/db/schema";
import type { AiJobStore, ClaimedJob, ClassifyContext, DraftContext, FailedAiJob, JobKind, SkippedAiJob } from "../../application/reply-ports";
import { AUTO_REQUEUE_BASE_SECONDS, AUTO_REQUEUE_CEILING, AUTO_REQUEUE_MAX_SECONDS, nextAutoRequeueAt, REQUEUEABLE_SKIP_REASONS, SWEEP_KINDS, type FailureKind } from "../domain/ai-job-requeue";
import { readUnknownSenderAiCap, UNKNOWN_SENDER_AI_CAP_KEY } from "@/contexts/tenancy/domain/ai-cap";
import { startOfLocalDay } from "@/contexts/outreach/domain/working-hours";
import { buildDraftContext, knowledgeFor, renderInstructions, threadEntries } from "../../infrastructure/thread-context";
import { publicConversation, publicConversationText } from "@/platform/db/conversation-visibility";
import { PENDING_DRAFT_STATUSES } from "../../domain/draft-status";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { settlesAfterAiPick } from "../../domain/workflow-state";
import { decideReplyType, typeRulesOf, type ReplyTypeFacts } from "../../domain/reply-type";
import { followUpModeFactsTx } from "../../infrastructure/follow-up-mode-facts";
import type { Tx } from "../../after-reply/infrastructure/sequence-stop";

/**
 * The facts of `decideReplyType` that the classify context does not carry, read in the apply transaction: the
 * confidence floor, and whether follow-ups apply (`followUpModeFactsTx`, as a person's type change reads them).
 */
async function applyFactsTx(
  tx: Tx,
  organizationId: string,
  record: { id: string; replyTypeSetId: string; activeChannel: string | null },
): Promise<Pick<ReplyTypeFacts, "floor" | "isContact" | "campaignMode" | "channel">> {
  const [[settings], mode] = await Promise.all([
    tx.select({ floor: replyHandlingSettings.autoApplyConfidence }).from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, record.replyTypeSetId)),
    followUpModeFactsTx(tx, organizationId, record.id),
  ]);
  return {
    floor: Number(settings?.floor ?? 0.85),
    isContact: mode?.isContact ?? false,
    campaignMode: mode?.campaignMode ?? null,
    channel: mode?.channel ?? record.activeChannel,
  };
}

interface JobRow {
  id: string;
  organization_id: string;
  kind: JobKind;
  entity_id: string;
  attempts: number;
  max_attempts: number;
}

const toClaimed = (r: JobRow): ClaimedJob => ({
  id: r.id,
  organizationId: r.organization_id,
  kind: r.kind,
  entityId: r.entity_id,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
});

/**
 * New work is due immediately. The claim compares `run_after` with the worker's clock, so a database clock a few
 * milliseconds ahead of the worker would hide a fresh job for a moment. A minute in the past avoids that.
 */
const DUE_NOW = sql`now() - interval '1 minute'`;

const UNLOCK = { lockedAt: null, lockedBy: null } as const;

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
 * The claim this worker still holds. A claim adds one attempt, so a job reclaimed after its lease ran out carries a
 * higher count, and the first worker's late settle matches nothing.
 */
const heldClaim = (job: ClaimedJob) => and(eq(aiJobs.id, job.id), eq(aiJobs.status, "running"), eq(aiJobs.attempts, job.attempts));

/** Stores why a job failed, and the requeue ceiling the first time it fails, in the job's own payload. */
const failureMarks = (kind: FailureKind) =>
  sql`${aiJobs.payload} || jsonb_build_object('failureKind', ${kind}::text, 'requeueCeiling', coalesce(${aiJobs.payload}->'requeueCeiling', to_jsonb(${AUTO_REQUEUE_CEILING}::int)))`;

const skipReasons = sql.join(REQUEUEABLE_SKIP_REASONS.map((r) => sql`${r}`), sql`, `);
const sweepKinds = sql.join(SWEEP_KINDS.map((k) => sql`${k}`), sql`, `);
const autoRequeueCount = sql`coalesce((payload->>'autoRequeues')::int, 0)`;
/** A job failed before kinds existed has no `failureKind`; it counts as transient. */
const sweepable = (now: Date) => sql`
  status = 'failed'
  and coalesce(payload->>'failureKind', 'transient') in (${sweepKinds})
  and ${autoRequeueCount} < coalesce((payload->>'requeueCeiling')::int, ${AUTO_REQUEUE_CEILING})
  and failed_at + make_interval(secs => least(${AUTO_REQUEUE_MAX_SECONDS}::double precision, ${AUTO_REQUEUE_BASE_SECONDS}::double precision * power(2, ${autoRequeueCount}))) <= ${now.toISOString()}::timestamptz`;

/**
 * The one transition from failed back to queued. Only rows that are failed when the statement runs change, and a
 * competing caller skips locked rows, so two callers never requeue the same job twice. A classification job also
 * loses its `failed` classification row: that row holds the (message, context version) slot the new result needs.
 */
async function requeue(organizationId: string, picked: ReturnType<typeof sql>, mode: "auto" | "manual", limit: number): Promise<string[]> {
  return db.transaction(async (tx) => {
    const counters =
      mode === "auto"
        ? sql`jsonb_build_object('autoRequeues', ${autoRequeueCount} + 1, 'requeueCeiling', coalesce(payload->'requeueCeiling', to_jsonb(${AUTO_REQUEUE_CEILING}::int)))`
        : // A person's decision gives the sweep a fresh ceiling.
          sql`jsonb_build_object('autoRequeues', 0, 'manualRequeues', coalesce((payload->>'manualRequeues')::int, 0) + 1, 'requeueCeiling', coalesce(payload->'requeueCeiling', to_jsonb(${AUTO_REQUEUE_CEILING}::int)))`;
    const rows = (await tx.execute(sql`
      with picked as (
        select id from ai_jobs
        where organization_id = ${organizationId} and ${picked}
        order by coalesce(failed_at, completed_at)
        limit ${limit}
        for update skip locked
      )
      update ai_jobs j
      set status = 'queued', attempts = 0, run_after = ${DUE_NOW}, failed_at = null, completed_at = null, locked_at = null, locked_by = null,
          last_error = case when j.status = 'skipped' then null else j.last_error end,
          payload = (j.payload - 'skipReason' - 'cap') || (select ${counters} from ai_jobs c where c.id = j.id)
      from picked
      where j.id = picked.id and j.status in ('failed', 'skipped')
      returning j.id, j.kind, j.entity_id
    `)) as unknown as Array<{ id: string; kind: JobKind; entity_id: string }>;
    const messageIds = rows.filter((r) => r.kind === "classification").map((r) => r.entity_id);
    if (messageIds.length > 0) {
      await tx.delete(replyTypePicks).where(and(eq(replyTypePicks.organizationId, organizationId), eq(replyTypePicks.status, "failed"), inArray(replyTypePicks.messageId, messageIds)));
    }
    return rows.map((r) => r.id);
  });
}

/**
 * Whether the organization ever wrote to the sender of message `m`: an outbound message to the address or in another
 * conversation of the same record (LinkedIn has no address), or a campaign send to a person with that address.
 */
const senderKnown = (m: string) => sql.raw(`(
  exists (select 1 from messages o where o.organization_id = ${m}.organization_id and o.direction = 'outbound' and lower(o.to_address) = lower(${m}.from_address))
  or exists (select 1 from messages o join conversations oc on oc.id = o.conversation_id join conversations mc on mc.record_id = oc.record_id
             where mc.id = ${m}.conversation_id and o.organization_id = ${m}.organization_id and o.direction = 'outbound' and ${publicConversationText("oc")})
  or exists (select 1 from sends s join campaign_enrollments e on e.id = s.enrollment_id join people p on p.id = e.person_id
             where s.organization_id = ${m}.organization_id and s.status in ('sending', 'sent', 'unknown') and lower(p.email) = lower(${m}.from_address))
)`);

const readPayload = (payload: Record<string, unknown>) => ({
  failureKind: (typeof payload.failureKind === "string" ? payload.failureKind : null) as FailureKind | null,
  autoRequeues: Number(payload.autoRequeues ?? 0),
  manualRequeues: Number(payload.manualRequeues ?? 0),
  requeueCeiling: Number(payload.requeueCeiling ?? AUTO_REQUEUE_CEILING),
});

export const drizzleAiJobStore: AiJobStore = {
  async enqueueMissing() {
    const rows = (await db.execute(sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, run_after)
      select r.organization_id, 'classification', 'message', r.latest_inbound_message_id, 'classification:message:' || r.latest_inbound_message_id, ${DUE_NOW}
      from records r
      where r.latest_inbound_message_id is not null
        and r.workflow_state not in ('paused', 'closed')
        and not exists (select 1 from ai_jobs j where j.kind = 'classification' and j.entity_type = 'message' and j.entity_id = r.latest_inbound_message_id)
        and not exists (select 1 from reply_type_picks c where c.message_id = r.latest_inbound_message_id and c.expected_context_version = r.context_version)
      on conflict do nothing
      returning id
    `)) as unknown as unknown[];
    return rows.length;
  },

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
          started_at = ${now.toISOString()}::timestamptz, attempts = j.attempts + 1
      from candidate
      where j.id = candidate.id
      returning j.id, j.organization_id, j.kind, j.entity_id, j.attempts, j.max_attempts
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
      const moved = await tx
        .update(aiJobs)
        .set({ ...endOrRerun({ status: "failed", at: now }), lastError, payload: sql`case when ${RERUN} then ${aiJobs.payload} - 'rerun' else ${failureMarks(failureKind)} end`, ...UNLOCK })
        .where(heldClaim(job))
        .returning({ id: aiJobs.id, status: aiJobs.status });
      if (moved.length === 0 || moved[0].status !== "failed" || job.kind !== "classification") return;
      const [record] = await tx
        .select({ id: records.id, personId: records.personId, version: records.contextVersion })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(records, eq(records.id, conversations.recordId))
        .where(and(eq(messages.id, job.entityId), eq(messages.organizationId, job.organizationId), publicConversation));
      if (!record) return;
      // Recorded so the panel can say why, and so the sweep does not queue the same message again.
      await tx
        .insert(replyTypePicks)
        .values({ organizationId: job.organizationId, recordId: record.id, messageId: job.entityId, expectedContextVersion: record.version, status: "failed", error: lastError })
        .onConflictDoNothing();
      await tx.insert(events).values({
        organizationId: job.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "reply_type_pick.failed",
        actorType: "ai",
        meta: { error: lastError },
        contextVersion: record.version,
      });
    });
  },

  async listFailed(organizationId, limit) {
    const where = and(eq(aiJobs.organizationId, organizationId), eq(aiJobs.status, "failed"));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(aiJobs).where(where);
    const rows = await db.select().from(aiJobs).where(where).orderBy(desc(aiJobs.failedAt)).limit(limit);
    return {
      total: n,
      rows: rows.map((r): FailedAiJob => {
        const state = readPayload(r.payload);
        const failedAt = r.failedAt ?? r.createdAt;
        return {
          id: r.id,
          kind: r.kind as JobKind,
          entityId: r.entityId,
          attempts: r.attempts,
          lastError: r.lastError ?? "",
          failedAt,
          ...state,
          nextAutoRequeueAt: nextAutoRequeueAt({ failureKind: state.failureKind, autoRequeues: state.autoRequeues, requeueCeiling: state.requeueCeiling, failedAt }),
        };
      }),
    };
  },

  async requeueFailed(organizationId, filter, _now, limit) {
    // A job the daily cap set aside is requeueable like a failed one: a person raised the cap, or a new day began.
    const skipped = sql`(status = 'skipped' and payload->>'skipReason' in (${skipReasons}))`;
    const picked =
      "jobId" in filter
        ? sql`id = ${filter.jobId} and (status = 'failed' or ${skipped})`
        : sql`((status = 'failed' and failed_at >= ${filter.since.toISOString()}::timestamptz) or (${skipped} and completed_at >= ${filter.since.toISOString()}::timestamptz))`;
    return requeue(organizationId, picked, "manual", limit);
  },

  async jobExists(organizationId, jobId) {
    const [row] = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.id, jobId), eq(aiJobs.organizationId, organizationId)));
    return Boolean(row);
  },

  async organizationsWithSweepable(now) {
    const rows = (await db.execute(sql`select distinct organization_id from ai_jobs where ${sweepable(now)}`)) as unknown as Array<{ organization_id: string }>;
    return rows.map((r) => r.organization_id);
  },

  async requeueSweepable(organizationId, now, limit) {
    return requeue(organizationId, sweepable(now), "auto", limit);
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
      .where(and(eq(aiJobs.id, job.id), eq(aiJobs.status, "running")))
      .returning({ id: aiJobs.id });
    return done.length > 0;
  },

  async listSkipped(organizationId, limit) {
    const where = and(eq(aiJobs.organizationId, organizationId), eq(aiJobs.status, "skipped"));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(aiJobs).where(where);
    const rows = await db.select().from(aiJobs).where(where).orderBy(desc(aiJobs.completedAt)).limit(limit);
    return {
      total: n,
      rows: rows.map((r): SkippedAiJob => ({
        id: r.id,
        kind: r.kind as JobKind,
        entityId: r.entityId,
        reason: typeof r.payload.skipReason === "string" ? r.payload.skipReason : "skipped",
        detail: r.lastError ?? "",
        skippedAt: r.completedAt ?? r.createdAt,
      })),
    };
  },

  async loadClassifyContext(organizationId, messageId) {
    const [row] = await db
      .select({
        conversationId: conversations.id,
        body: messages.bodyText,
        recordId: records.id,
        replyTypeSetId: records.replyTypeSetId,
        contextVersion: records.contextVersion,
        latest: records.latestInboundMessageId,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(records, eq(records.id, conversations.recordId))
      .where(and(eq(messages.id, messageId), eq(messages.organizationId, organizationId), publicConversation));
    if (!row) return null;

    const taxonomyRows = await db
      .select()
      .from(replyTypes)
      .where(and(eq(replyTypes.replyTypeSetId, row.replyTypeSetId), eq(replyTypes.active, true)))
      .orderBy(replyTypes.sortOrder);
    const [settings] = await db.select().from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, row.replyTypeSetId));
    const thread = await threadEntries(organizationId, row.conversationId);
    if (!thread) return null;
    const knowledge = await knowledgeFor(organizationId, { alwaysOnly: true });

    const ctx: ClassifyContext = {
      recordId: row.recordId,
      contextVersion: row.contextVersion,
      latestInboundMessageId: row.latest,
      operatorInstructions: renderInstructions(settings?.classificationInstructions),
      businessContext: knowledge.map((k) => `${k.title}\n${k.content}`).join("\n\n"),
      taxonomy: taxonomyRows.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        groupKey: t.groupKey,
        description: t.description,
        guidance: t.classificationGuidance,
        systemRole: t.systemRole,
        rules: typeRulesOf(t),
      })),
      person: thread.person,
      thread: thread.entries,
      messageText: row.body,
    };
    return ctx;
  },

  async finishClassification(input) {
    return db.transaction(async (tx) => {
      const [record] = await tx
        .select({
          id: records.id,
          personId: records.personId,
          replyTypeSetId: records.replyTypeSetId,
          version: records.contextVersion,
          latest: records.latestInboundMessageId,
          groupKey: records.groupKey,
          replyTypeId: records.replyTypeId,
          locked: records.replyTypeLocked,
          activeChannel: records.activeChannel,
          state: records.workflowState,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(records, eq(records.id, conversations.recordId))
        .where(and(eq(messages.id, input.messageId), eq(messages.organizationId, input.job.organizationId), publicConversation))
        .for("update", { of: records });
      if (!record) return { status: "stale" as const };
      // A type archived after the job read its context is no longer a choice: the result is stored stale.
      const [proposed] = await tx
        .select()
        .from(replyTypes)
        .where(and(eq(replyTypes.replyTypeSetId, record.replyTypeSetId), eq(replyTypes.key, input.proposedReplyTypeKey), eq(replyTypes.active, true)));

      const base = {
        rules: proposed ? typeRulesOf(proposed) : null,
        organizationId: input.job.organizationId,
        recordId: record.id,
        messageId: input.messageId,
        expectedContextVersion: input.expectedContextVersion,
        previousGroupKey: record.groupKey,
        previousReplyTypeId: record.replyTypeId,
        proposedGroupKey: proposed?.groupKey ?? null,
        proposedReplyTypeId: proposed?.id ?? null,
        confidence: input.confidence.toFixed(4),
        reasoning: input.reason,
        provider: input.provider,
        model: input.model,
        request: input.request,
      };

      // A newer reply or a person's decision since the work started: this result must not overwrite it.
      if (record.version !== input.expectedContextVersion || record.latest !== input.messageId || !proposed) {
        await tx
          .insert(replyTypePicks)
          .values({ ...base, status: "stale", response: input.response })
          .onConflictDoNothing();
        return { status: "stale" as const };
      }

      // The one decision for this pick, under the record lock and with the facts as they are now: a floor raised or a
      // lock set after the job read its context holds the pick here.
      const decision = decideReplyType(
        { groupKey: proposed.groupKey, rules: typeRulesOf(proposed) },
        {
          ...(await applyFactsTx(tx, input.job.organizationId, record)),
          stopRequested: input.stopRequested,
          confidence: input.confidence,
          locked: record.locked,
          currentType: { groupKey: record.groupKey },
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
          response: { ...(input.response as object), holdReason: decision.hold, stopRequested: input.stopRequested, previousLocked: record.locked },
        })
        .onConflictDoNothing()
        .returning({ id: replyTypePicks.id });
      // Someone (a person, or another worker) already settled this message at this context version.
      if (!row) return { status: "stale" as const };

      if (auto) {
        const settle = settlesAfterAiPick(record.state, decision, input.stopRequested);
        await tx
          .update(records)
          .set({
            groupKey: proposed.groupKey,
            replyTypeId: proposed.id,
            replyTypeSource: "ai",
            ...(settle ? { workflowState: "idle" } : {}),
          })
          .where(eq(records.id, record.id));
        await interruptOnTerminalStageTx(tx, {
          organizationId: input.job.organizationId,
          recordId: record.id,
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
        personId: record.personId,
        recordId: record.id,
        eventType: auto ? "reply_type_pick.applied" : "reply_type_pick.proposed",
        actorType: "ai",
        fromData: { groupKey: record.groupKey, replyTypeId: record.replyTypeId },
        toData: { groupKey: proposed.groupKey, replyTypeId: proposed.id },
        meta: { confidence: input.confidence, holdReason: decision.hold, stopRequested: input.stopRequested },
        contextVersion: input.expectedContextVersion,
      });
      return { status: auto ? ("auto_applied" as const) : ("proposed" as const) };
    });
  },

  async loadDraftContext(organizationId, replyTypePickId) {
    const [cls] = await db
      .select({
        status: replyTypePicks.status,
        expected: replyTypePicks.expectedContextVersion,
        messageId: replyTypePicks.messageId,
        recordId: replyTypePicks.recordId,
        conversationId: messages.conversationId,
        response: replyTypePicks.response,
      })
      .from(replyTypePicks)
      .innerJoin(messages, eq(messages.id, replyTypePicks.messageId))
      .where(and(eq(replyTypePicks.id, replyTypePickId), eq(replyTypePicks.organizationId, organizationId)));
    if (!cls) return null;
    const ctx = await buildDraftContext(organizationId, cls.conversationId);
    if (!ctx) return null;

    const skip = await (async (): Promise<string | null> => {
      if (!["auto_applied", "accepted", "overridden"].includes(cls.status)) return "not_applied";
      if (ctx.contextVersion !== cls.expected) return "stale";
      const [rec] = await db.select({ out: records.lastOutboundAt, inb: records.lastInboundAt, personId: records.personId }).from(records).where(eq(records.id, cls.recordId));
      if (rec.out && rec.inb && rec.out >= rec.inb) return "answered";
      const [open] = await db
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.conversationId, ctx.conversationId), eq(drafts.expectedContextVersion, ctx.contextVersion), inArray(drafts.status, [...PENDING_DRAFT_STATUSES, "sent"])))
        .limit(1);
      if (open) return "has_draft";
      if (ctx.channel === "linkedin") {
        // The chat is the recipient. Only a do-not-contact person blocks a reply there (email suppression does not apply).
        const [dnc] = await db.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, rec.personId));
        return dnc?.d ? "blocked" : null;
      }
      const email = ctx.person.email?.toLowerCase();
      if (!email) return "no_recipient";
      const [blocked] = await db
        .select({ one: sql<number>`1` })
        .from(people)
        .leftJoin(contactPolicies, and(eq(contactPolicies.personId, people.id), eq(contactPolicies.doNotContact, true)))
        .leftJoin(suppressionList, and(eq(suppressionList.organizationId, people.organizationId), eq(suppressionList.email, email)))
        .where(and(eq(people.id, rec.personId), sql`(${contactPolicies.personId} is not null or ${suppressionList.id} is not null)`));
      return blocked ? "blocked" : null;
    })();
    return { ...(ctx as DraftContext), skip };
  },
};
