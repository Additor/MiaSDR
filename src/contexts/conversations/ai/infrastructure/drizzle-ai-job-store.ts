import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { aiJobs, replyTypePicks, conversations, drafts, messages, replyHandlingSettings, records, replyTypes } from "@/platform/db/schema";
import type { AiJobQueueStore, AiJobStore, ClassifyContext, DraftContext, FailedAiJob, JobKind, SkippedAiJob } from "../../application/reply-ports";
import { AUTO_REQUEUE_BASE_SECONDS, AUTO_REQUEUE_CEILING, AUTO_REQUEUE_MAX_SECONDS, nextAutoRequeueAt, REQUEUEABLE_SKIP_REASONS, SWEEP_KINDS, type FailureKind } from "../domain/ai-job-requeue";
import { buildDraftContext, knowledgeFor, renderInstructions, threadEntries } from "../../infrastructure/thread-context";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { PENDING_DRAFT_STATUSES } from "../../domain/draft-status";
import { typeRulesOf } from "../../domain/reply-type";
import { isDoNotContact, isSuppressed } from "@/contexts/people/infrastructure/reachability";
import { DUE_NOW, drizzleAiJobWorkerStore } from "./drizzle-ai-job-worker-store";

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
      set status = 'queued', attempts = 0, run_after = ${DUE_NOW}, failed_at = null, completed_at = null, locked_at = null, locked_by = null, claim_token = null,
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

const readPayload = (payload: Record<string, unknown>) => ({
  failureKind: (typeof payload.failureKind === "string" ? payload.failureKind : null) as FailureKind | null,
  autoRequeues: Number(payload.autoRequeues ?? 0),
  manualRequeues: Number(payload.manualRequeues ?? 0),
  requeueCeiling: Number(payload.requeueCeiling ?? AUTO_REQUEUE_CEILING),
});

const queueStore: AiJobQueueStore = {
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
        return (await isDoNotContact(db, organizationId, rec.personId)) ? "blocked" : null;
      }
      if (!ctx.person.email?.trim()) return "no_recipient";
      return (await isDoNotContact(db, organizationId, rec.personId)) || (await isSuppressed(db, organizationId, ctx.person.email)) ? "blocked" : null;
    })();
    return { ...(ctx as DraftContext), skip };
  },
};

/** The whole AI job store: the queue, and the worker's fenced claim methods (`drizzle-ai-job-worker-store.ts`). */
export const drizzleAiJobStore: AiJobStore = { ...queueStore, ...drizzleAiJobWorkerStore };
