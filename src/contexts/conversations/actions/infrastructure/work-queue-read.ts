import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { identityExceptions } from "@/platform/db/schema";
import type { ActionQueue, ActionQueueCounts, ActionQueueExtras, QueueGroupPage, QueueItem, QueuePosition, WorkQueueStore } from "../application/work-queue-ports";
import { NO_TYPE_FILTER, QUEUE_GROUPS, QUEUE_SCOPES, encodeQueueCursor, type PickReviewKind, type QueueFilter, type QueueGroup, type QueueProblemKind, type QueueScope, type WaitingBasis } from "../domain/action-queue";
import { publicConversationSql, visibleReplyTypePickSql, visibleDraftSql, visibleRecordSql } from "@/platform/db/conversation-visibility";
import { rowsOf } from "@/platform/db/sql-values";
import { holdReasonOf } from "../../domain/reply-type";

/*
 * work-queue-read: the explicit read model of the Actions queue, built like `deals/infrastructure/crm-read.ts`.
 *
 * Tables it reads, and only these:
 *   records         r   (the rows: workflow state, next action time, last interaction)
 *   people          p   (name, lifecycle)
 *   reply_types     s   (the record's current reply type)
 *   drafts          d   (a draft to review, a failed or unconfirmed draft)
 *   ai_jobs         j   (a failed classification or draft job that still applies)
 *   reply_type_picks k  (the AI pick of the latest reply, and what it waits for)
 *   contact_policies, suppression_list (whether a stop request is still open)
 *   conversations   c   (the thread to open, public ones only)
 *   tasks           t   (an open task takes a next_step record out of the queue; open tasks are counted by assignee)
 *   users           au  (the assignee's name)
 *   campaign_enrollments (the campaign filter)
 *   sends, campaigns (campaign sends the provider never confirmed)
 *   identity_exceptions (open unmatched senders)
 *
 * It is read only: no statement here writes. Every statement filters by organization and by the visibility rules of
 * `conversation-visibility.ts`. The rule behind a row's group and membership is `queueGroupOf` and `isInQueue` in
 * `domain/action-queue.ts`, and what an AI pick waits for is `pickReviewOf`; `action-queue.integration.test.ts` checks that
 * this SQL agrees with them. Membership reads `records.workflow_state` as the domain wrote it and works none of it out again.
 */

const date = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string));

/**
 * One row per record that needs a person: `action_required` or `error`, or `waiting` with `next_action_at` due.
 * `grp` is the first match of problem, reply, classification, follow_up, next_step. A `next_step` record with an
 * open task is left out, because the task already shows it. The list, the totals and the badges all read this. The snippet of
 * a row is not here: it reads message bodies, so it is read for the rows of one page only (`snippetsOf`).
 */
const queueRowsSql = (organizationId: string) => sql`
  select q.*,
    case q.grp when 'problem' then coalesce(q.pd_updated, q.fj_at, q.r_updated) when 'follow_up' then coalesce(q.next_action_at, q.inbound_at) else q.inbound_at end as waiting_at,
    case q.grp when 'problem' then 'failure' when 'follow_up' then 'due' else 'inbound' end as wait_basis
  from (
    select r.id as record_id, r.person_id, r.group_key, r.workflow_state, r.active_channel, r.next_action_at, r.reply_type_id,
           r.assigned_to, au.name as assignee_name,
           coalesce(r.last_inbound_at, r.last_interaction_at, r.created_at) as inbound_at, r.updated_at as r_updated,
           p.full_name, p.first_name, p.email, p.lifecycle, s.name as sub_name,
           pd.id as pd_id, pd.status as pd_status, pd.error as pd_error, pd.conversation_id as pd_conv, pd.subject as pd_subject, pd.updated_at as pd_updated,
           rd.id as rd_id, rd.conversation_id as rd_conv, rd.subject as rd_subject, rd.updated_at as rd_updated,
           fj.id as fj_id, fj.last_error as fj_error, fj.failed_at as fj_at,
           nk.id as k_id, nk.kind as k_kind, nk.confidence as k_confidence, nk.ctx as k_ctx, nk.cat as k_cat, nk.sub_name as k_sub, nk.hold_reason as k_hold,
           cv.id as conv_id,
           case
             when r.workflow_state = 'error' or pd.id is not null or fj.id is not null then 'problem'
             when rd.id is not null then 'reply'
             when nk.kind is not null then 'classification'
             when r.workflow_state = 'waiting' then 'follow_up'
             else 'next_step'
           end as grp,
           exists (select 1 from tasks t where t.record_id = r.id and not t.is_completed) as has_task
    from records r
    join people p on p.id = r.person_id
    left join reply_types s on s.id = r.reply_type_id
    left join users au on au.id = r.assigned_to
    left join lateral (
      select d.id, d.status, d.error, d.conversation_id, d.subject, d.updated_at from drafts d
      where d.record_id = r.id and d.status in ('failed', 'delivery_uncertain') and ${visibleDraftSql("d")} order by d.updated_at desc limit 1
    ) pd on true
    left join lateral (
      select d.id, d.conversation_id, d.subject, d.updated_at from drafts d
      where d.record_id = r.id and d.status = 'awaiting_review' and ${visibleDraftSql("d")} order by d.updated_at desc limit 1
    ) rd on true
    left join lateral (
      select j.id, j.last_error, j.failed_at from ai_jobs j
      where j.organization_id = r.organization_id and j.status = 'failed' and r.latest_inbound_message_id is not null
        and (
          (j.kind = 'classification' and j.entity_type = 'message' and j.entity_id = r.latest_inbound_message_id
            and not exists (select 1 from reply_type_picks c where c.record_id = r.id and c.message_id = r.latest_inbound_message_id and c.status <> 'stale'))
          or (j.kind = 'initial_draft' and j.entity_type = 'classification'
            and exists (select 1 from reply_type_picks c where c.id = j.entity_id and c.record_id = r.id and c.message_id = r.latest_inbound_message_id
                          and c.expected_context_version = r.context_version and c.status not in ('stale', 'rejected')))
        )
        and not exists (select 1 from drafts d where d.record_id = r.id and d.status in ('generating', 'awaiting_review', 'sending', 'sent') and d.created_at >= j.created_at)
      order by j.failed_at desc limit 1
    ) fj on true
    left join lateral (
      -- The pick of the latest reply (a stale one only when nothing else exists), and what it waits for: pickReviewOf.
      select lp.id, lp.confidence, lp.ctx, lp.cat, lp.sub_name, lp.hold_reason,
             case
               when (lp.held or lp.applied) and lp.stop_asked and not lp.stopped then 'stop_review'
               when lp.held and lp.proposed_role is distinct from 'stop_request' and lp.proposed_name is not null then 'held'
               when lp.applied and coalesce(lp.check_mode, 'after') = 'after' then 'looks_right'
             end as kind
      from (
        select k.id, k.confidence, k.expected_context_version as ctx, coalesce(k.applied_group_key, k.proposed_group_key) as cat, ks.name as sub_name,
               kp.name as proposed_name, kp.system_role as proposed_role, k.rules->>'checkMode' as check_mode, k.response->>'holdReason' as hold_reason,
               k.status = 'proposed' and k.expected_context_version = r.context_version as held,
               k.status = 'auto_applied' and k.acknowledged_at is null
                 and k.applied_reply_type_id is not distinct from r.reply_type_id and k.applied_group_key is not distinct from r.group_key as applied,
               coalesce((k.response->>'stopRequested')::boolean, false) or kp.system_role = 'stop_request' as stop_asked,
               exists (select 1 from contact_policies cp where cp.person_id = r.person_id and cp.organization_id = r.organization_id and cp.do_not_contact)
                 or (coalesce(r.active_channel, 'email') = 'email' and p.email is not null
                     and exists (select 1 from suppression_list sl where sl.organization_id = r.organization_id and sl.email = lower(p.email))) as stopped
        from reply_type_picks k
        left join reply_types ks on ks.id = coalesce(k.applied_reply_type_id, k.proposed_reply_type_id)
        -- An archived proposed type cannot be accepted, so its held pick waits for nothing here.
        left join reply_types kp on kp.id = k.proposed_reply_type_id and kp.active
        where k.record_id = r.id and k.message_id = r.latest_inbound_message_id and ${visibleReplyTypePickSql("k")}
        order by (k.status = 'stale'), k.created_at desc limit 1
      ) lp
    ) nk on true
    left join lateral (
      select c.id from conversations c where c.record_id = r.id and ${publicConversationSql("c")} order by (c.channel = r.active_channel) desc, c.updated_at desc limit 1
    ) cv on true
    where r.organization_id = ${organizationId} and ${visibleRecordSql("r")}
      and (r.workflow_state in ('action_required', 'error') or (r.workflow_state = 'waiting' and r.next_action_at <= now()))
  ) q
  where not (q.grp = 'next_step' and q.has_task)`;

/** Filters on the queue rows, without the action type. The totals use these alone. */
function queueConditions(filter: QueueFilter, actorUserId: string) {
  const parts = [sql`true`];
  if (filter.scope === "mine") parts.push(sql`q.assigned_to = ${actorUserId}`);
  else if (filter.scope === "unassigned") parts.push(sql`q.assigned_to is null`);
  else if (filter.scope === "others") parts.push(sql`q.assigned_to is not null and q.assigned_to <> ${actorUserId}`);
  if (filter.groupKey === NO_TYPE_FILTER) parts.push(sql`q.group_key is null`);
  else if (filter.groupKey) parts.push(sql`q.group_key = ${filter.groupKey}`);
  if (filter.channel) parts.push(sql`q.active_channel = ${filter.channel}`);
  if (filter.replyTypeId) parts.push(sql`q.reply_type_id = ${filter.replyTypeId}`);
  if (filter.campaignId) {
    // People currently enrolled in the campaign, email or LinkedIn (one enrollments table): a removed enrollment does not
    // count, every other status does. This is not the campaign that owns the conversation.
    parts.push(sql`exists (select 1 from records cr join campaign_enrollments ce on ce.person_id = cr.person_id and ce.organization_id = cr.organization_id where cr.id = q.record_id and ce.campaign_id = ${filter.campaignId} and ce.status <> 'removed')`);
  }
  if (filter.dueBefore) parts.push(sql`q.next_action_at <= ${filter.dueBefore.toISOString()}::timestamptz`);
  if (filter.dueAfter) parts.push(sql`q.next_action_at >= ${filter.dueAfter.toISOString()}::timestamptz`);
  return sql.join(parts, sql` and `);
}

const emptyCounts = (): Record<QueueGroup, number> => ({ reply: 0, follow_up: 0, classification: 0, next_step: 0, problem: 0 });

async function queueTotals(organizationId: string, actorUserId: string, filter: QueueFilter): Promise<Record<QueueGroup, number>> {
  const rows = rowsOf<{ grp: QueueGroup; n: number }>(
    await db.execute(sql`select q.grp, count(*)::int as n from (${queueRowsSql(organizationId)}) q where ${queueConditions(filter, actorUserId)} group by q.grp`),
  );
  const totals = emptyCounts();
  for (const row of rows) totals[row.grp] = row.n;
  return totals;
}

/**
 * The start of the latest inbound message of each thread, on one line. The thread of a row is the one it opens, so the
 * caller passes `QueueItem.conversationId`. The read still keeps to public conversations, like every message read.
 */
async function snippetsOf(conversationIds: string[]): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();
  const rows = rowsOf<{ conversation_id: string; snippet: string | null }>(
    await db.execute(sql`
      select distinct on (m.conversation_id) m.conversation_id,
             left(btrim(regexp_replace(m.body_text, '[[:space:]]+', ' ', 'g')), 140) as snippet
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.conversation_id in (${sql.join(conversationIds.map((id) => sql`${id}::uuid`), sql`, `)}) and m.direction = 'inbound'
        and ${publicConversationSql("c")}
      order by m.conversation_id, m.sent_at desc, m.id desc`),
  );
  return new Map(rows.filter((r) => r.snippet).map((r) => [r.conversation_id, r.snippet as string]));
}

/** The start of the current text of each draft (the edited text when a person changed it), on one line, for the rows of a page. */
async function draftPreviewsOf(organizationId: string, draftIds: string[]): Promise<Map<string, string>> {
  if (draftIds.length === 0) return new Map();
  const rows = rowsOf<{ id: string; preview: string | null }>(
    await db.execute(sql`
      select d.id, left(btrim(regexp_replace(coalesce(d.edited_body_text, d.ai_body_text, ''), '[[:space:]]+', ' ', 'g')), 140) as preview
      from drafts d
      where d.organization_id = ${organizationId} and d.id in (${sql.join(draftIds.map((id) => sql`${id}::uuid`), sql`, `)})`),
  );
  return new Map(rows.filter((r) => r.preview).map((r) => [r.id, r.preview as string]));
}

function toQueueItem(r: Record<string, unknown>): QueueItem {
  const group = r.grp as QueueGroup;
  const problemKind: QueueProblemKind | null =
    group !== "problem" ? null : r.pd_id ? (r.pd_status === "delivery_uncertain" ? "delivery_uncertain" : "draft_failed") : r.fj_id ? "job_failed" : "record_error";
  const problemMessage: Record<QueueProblemKind, string> = {
    record_error: "Reply handling is in an error state.",
    draft_failed: (r.pd_error as string | null) ?? "The draft cannot be sent as written.",
    delivery_uncertain: (r.pd_error as string | null) ?? "The provider never confirmed delivery.",
    job_failed: (r.fj_error as string | null) ?? "The AI job failed.",
  };
  const draftId = (r.pd_id ?? r.rd_id) as string | null;
  const usesProblemDraft = problemKind === "draft_failed" || problemKind === "delivery_uncertain";
  return {
    recordId: r.record_id as string,
    personId: r.person_id as string,
    group,
    personName: (r.full_name as string | null) ?? (r.first_name as string | null) ?? (r.email as string | null),
    personLifecycle: r.lifecycle as "lead" | "contact",
    conversationId: ((usesProblemDraft ? r.pd_conv : r.rd_conv) ?? r.conv_id ?? null) as string | null,
    groupKey: r.group_key as string | null,
    replyTypeName: r.sub_name as string | null,
    channel: r.active_channel as string | null,
    workflowState: r.workflow_state as string,
    assignee: r.assigned_to ? { id: r.assigned_to as string, name: (r.assignee_name as string | null) ?? null } : null,
    nextActionAt: date(r.next_action_at),
    snippet: null,
    waitingSince: { at: new Date(r.waiting_at as string), basis: r.wait_basis as WaitingBasis },
    draft: draftId
      ? usesProblemDraft || group === "reply"
        ? { draftId: (usesProblemDraft ? r.pd_id : r.rd_id) as string, status: usesProblemDraft ? (r.pd_status as string) : "awaiting_review", subject: (usesProblemDraft ? r.pd_subject : r.rd_subject) as string | null, updatedAt: new Date((usesProblemDraft ? r.pd_updated : r.rd_updated) as string), preview: null }
        : null
      : null,
    classification: r.k_kind
      ? { replyTypePickId: r.k_id as string, kind: r.k_kind as PickReviewKind, groupKey: r.k_cat as string | null, name: r.k_sub as string | null, confidence: r.k_confidence === null ? null : Number(r.k_confidence), contextVersion: Number(r.k_ctx), unlocksCustomer: holdReasonOf(r.k_hold) === "protected_customer" }
      : null,
    problem: problemKind ? { kind: problemKind, message: problemMessage[problemKind] } : null,
  };
}

export const drizzleWorkQueueStore: WorkQueueStore = {
  async actionQueue(organizationId, { actorUserId, filter, limit, cursor }): Promise<ActionQueue> {
    const totals = await queueTotals(organizationId, actorUserId, filter);
    const wanted = QUEUE_GROUPS.filter((g) => (filter.group ? g === filter.group : true) && totals[g] > 0);
    const pages = await Promise.all(
      wanted.map(async (group): Promise<[QueueGroup, QueueGroupPage]> => {
        const after = cursor ? sql`and (q.waiting_at, q.record_id) > (${cursor.sortKey}::timestamptz, ${cursor.recordId}::uuid)` : sql``;
        const rows = rowsOf<Record<string, unknown>>(
          await db.execute(sql`
            select q.*, q.waiting_at::text as sort_key from (${queueRowsSql(organizationId)}) q
            where q.grp = ${group} and ${queueConditions(filter, actorUserId)} ${after}
            order by q.waiting_at asc, q.record_id asc limit ${limit + 1}`),
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const nextCursor = rows.length > limit && last ? encodeQueueCursor({ sortKey: last.sort_key as string, recordId: last.record_id as string }) : null;
        return [group, { total: totals[group], items: page.map(toQueueItem), nextCursor }];
      }),
    );
    const groups = Object.fromEntries(QUEUE_GROUPS.map((g) => [g, { total: totals[g], items: [], nextCursor: null } satisfies QueueGroupPage])) as unknown as Record<QueueGroup, QueueGroupPage>;
    for (const [group, page] of pages) groups[group] = page;
    const snippets = await snippetsOf([...new Set(pages.flatMap(([, page]) => page.items.map((i) => i.conversationId).filter((id): id is string => id !== null)))]);
    for (const [, page] of pages) for (const item of page.items) item.snippet = (item.conversationId && snippets.get(item.conversationId)) || null;
    const previews = await draftPreviewsOf(organizationId, [...new Set(pages.flatMap(([, page]) => page.items.flatMap((i) => (i.draft ? [i.draft.draftId] : []))))]);
    for (const [, page] of pages) for (const item of page.items) if (item.draft) item.draft.preview = previews.get(item.draft.draftId) ?? null;
    return { groups, total: QUEUE_GROUPS.reduce((sum, g) => sum + totals[g], 0) };
  },

  async actionQueueCounts(organizationId, actorUserId): Promise<ActionQueueCounts> {
    const [records, tasks] = await Promise.all([
      // One pass over the queue rows: the group totals, the scope totals and the oldest wait per scope. The oldest wait leaves
      // follow-ups out: a due time says how late a touch is, not how long a person has waited.
      db.execute(sql`
        select q.grp,
               count(*)::int as n,
               count(*) filter (where q.assigned_to = ${actorUserId})::int as mine,
               count(*) filter (where q.assigned_to is null)::int as unassigned,
               count(*) filter (where q.assigned_to <> ${actorUserId})::int as others,
               min(q.waiting_at) filter (where q.wait_basis in ('inbound', 'failure') and q.assigned_to = ${actorUserId}) as oldest_mine,
               min(q.waiting_at) filter (where q.wait_basis in ('inbound', 'failure') and q.assigned_to is null) as oldest_unassigned,
               min(q.waiting_at) filter (where q.wait_basis in ('inbound', 'failure') and q.assigned_to <> ${actorUserId}) as oldest_others
        from (${queueRowsSql(organizationId)}) q
        group by q.grp`),
      // Open tasks, except those on a record that exists only for a private thread.
      db.execute(sql`
        select count(*) filter (where t.assigned_to = ${actorUserId})::int as mine,
               count(*) filter (where t.assigned_to is null)::int as unassigned,
               count(*) filter (where t.assigned_to <> ${actorUserId})::int as others
        from tasks t
        where t.organization_id = ${organizationId} and not t.is_completed
          and (t.record_id is null or exists (select 1 from records tr where tr.id = t.record_id and ${visibleRecordSql("tr")}))`),
    ]);
    const groupRows = rowsOf<Record<string, unknown>>(records);
    const byGroup = emptyCounts();
    const byScope = Object.fromEntries(QUEUE_SCOPES.map((scope) => [scope, 0])) as Record<QueueScope, number>;
    const oldestWaiting = Object.fromEntries(QUEUE_SCOPES.map((scope) => [scope, null])) as Record<QueueScope, Date | null>;
    for (const row of groupRows) {
      byGroup[row.grp as QueueGroup] = Number(row.n);
      for (const scope of QUEUE_SCOPES) {
        byScope[scope] += Number(row[scope] ?? 0);
        const oldest = date(row[`oldest_${scope}`]);
        if (oldest && (!oldestWaiting[scope] || oldest < (oldestWaiting[scope] as Date))) oldestWaiting[scope] = oldest;
      }
    }
    const [taskRow] = rowsOf<Record<QueueScope, number>>(tasks);
    const taskScopes = Object.fromEntries(QUEUE_SCOPES.map((scope) => [scope, Number(taskRow?.[scope] ?? 0)])) as Record<QueueScope, number>;
    const work = Object.fromEntries(QUEUE_SCOPES.map((scope) => [scope, byScope[scope] + taskScopes[scope]])) as Record<QueueScope, number>;
    return {
      total: QUEUE_GROUPS.reduce((sum, g) => sum + byGroup[g], 0),
      byGroup,
      byScope,
      tasks: taskScopes,
      work,
      oldestWaiting,
    };
  },

  async queuePosition(organizationId, { actorUserId, filter, recordId }): Promise<QueuePosition | null> {
    const [row] = rowsOf<{ grp: QueueGroup; sort_key: string }>(
      await db.execute(sql`
        select q.grp, q.waiting_at::text as sort_key from (${queueRowsSql(organizationId)}) q
        where q.record_id = ${recordId}::uuid and ${queueConditions(filter, actorUserId)}
          ${filter.group ? sql`and q.grp = ${filter.group}` : sql``}`),
    );
    return row ? { group: row.grp, cursor: { sortKey: row.sort_key, recordId } } : null;
  },

  async actionQueueExtras(organizationId): Promise<ActionQueueExtras> {
    const [campaignSends, exceptions] = await Promise.all([
      db.execute(sql`
        select s.id as send_id, c.id as campaign_id, c.name as campaign_name, s.channel, p.full_name, p.first_name, p.email, s.claimed_at
        from sends s
        join campaign_enrollments e on e.id = s.enrollment_id
        join campaigns c on c.id = e.campaign_id
        join people p on p.id = e.person_id
        where s.organization_id = ${organizationId} and s.status = 'unknown'
        order by s.claimed_at desc limit 200`),
      db.select({ n: count() }).from(identityExceptions).where(and(eq(identityExceptions.organizationId, organizationId), eq(identityExceptions.status, "open"))),
    ]);
    return {
      uncertainCampaignSends: rowsOf<Record<string, unknown>>(campaignSends).map((r) => ({
        sendId: r.send_id as string,
        campaignId: r.campaign_id as string,
        campaignName: r.campaign_name as string,
        channel: r.channel as string,
        personName: (r.full_name as string | null) ?? (r.first_name as string | null) ?? (r.email as string | null),
        claimedAt: new Date(r.claimed_at as string),
      })),
      openIdentityExceptions: exceptions[0]?.n ?? 0,
    };
  },
};
