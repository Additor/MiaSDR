import { sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import type { ClaimedStep, InterruptCandidate, SequenceEngineStore } from "../application/sequence-ports";
import { MAX_DRAFT_ATTEMPTS, stepTypeAt, type InterruptFacts } from "../domain/sequences";
import { NEW_REPLY_MARGIN_MINUTES } from "../domain/after-reply";
import type { FollowUpsRule } from "../../domain/reply-type";
import { flowRunnableSql, owningCampaignSql, startableCampaignSql } from "./after-reply-sql";
import { rowsOf } from "@/platform/db/sql-values";
import { advanceRunTx, asDate, ts, zoneOfTx } from "./sequence-run-tx";
import { endRunTx, recordEvent, type Tx } from "./sequence-stop";
import { knowledgeFor } from "../../infrastructure/thread-context";
import { PENDING_DRAFT_STATUSES, RETIRABLE_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES } from "../../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";

const PENDING_DRAFTS = sqlValues(PENDING_DRAFT_STATUSES);

interface FactsRow {
  run_id: string;
  organization_id: string;
  record_id: string;
  trigger_message_id: string;
  run_reply_type_id: string;
  latest_inbound_message_id: string | null;
  reply_type_id: string | null;
  group_key: string | null;
  sub_key: string | null;
  follow_ups: FollowUpsRule | null;
  workflow_state: string;
  dnc: boolean;
  suppression: InterruptFacts["suppression"];
  contact: boolean;
  flow_active: boolean;
}

const toCandidate = (r: FactsRow): InterruptCandidate => ({
  runId: r.run_id,
  organizationId: r.organization_id,
  recordId: r.record_id,
  facts: {
    run: { triggerMessageId: r.trigger_message_id, replyTypeId: r.run_reply_type_id },
    record: { latestInboundMessageId: r.latest_inbound_message_id, replyTypeId: r.reply_type_id, groupKey: r.group_key, replyTypeKey: r.sub_key, followUps: r.follow_ups, workflowState: r.workflow_state },
    doNotContact: r.dnc,
    suppression: r.suppression,
    contact: r.contact,
    flowActive: r.flow_active,
  },
});

/** The facts that decide whether a run must stop, for the runs matching `where`. Every join stays inside the run's organization. */
const factsQuery = (where: SQL, tail: SQL = sql``) => sql`
  select r.id as run_id, r.organization_id, r.record_id, r.trigger_message_id, r.reply_type_id as run_reply_type_id,
         rec.latest_inbound_message_id, rec.reply_type_id, rec.group_key, s.key as sub_key, s.follow_ups, rec.workflow_state,
         coalesce((select cp.do_not_contact from contact_policies cp where cp.person_id = rec.person_id and cp.organization_id = r.organization_id), false) as dnc,
         (select sl.reason from suppression_list sl where sl.organization_id = r.organization_id and sl.email = lower(p.email)
           order by case sl.reason when 'complaint' then 0 when 'unsubscribed' then 1 when 'bounced' then 2 else 3 end limit 1) as suppression,
         p.lifecycle = 'contact' as contact,
         ${flowRunnableSql("fl")} as flow_active
  from sequence_runs r
  join sequences fl on fl.id = r.sequence_id and fl.organization_id = r.organization_id
  join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
  join people p on p.id = rec.person_id and p.organization_id = r.organization_id
  left join reply_types s on s.id = rec.reply_type_id
  where ${where} ${tail}`;

export const drizzleSequenceEngine: SequenceEngineStore = {
  // Only new replies start a run: the reply arrived no earlier than NEW_REPLY_MARGIN_MINUTES before the flow was turned
  // on, and the record's reply type keeps follow-ups going (`reply_types.follow_ups`, the rule `startBlockedReason` reads).
  async startCandidates(limit) {
    return rowsOf<{ organization_id: string; id: string }>(
      await db.execute(sql`
        select r.organization_id, r.id
        from records r
        join reply_types s on s.id = r.reply_type_id
        join people p on p.id = r.person_id
        join messages lm on lm.id = r.latest_inbound_message_id
        join conversations c on c.id = lm.conversation_id and c.channel = 'email'
        join lateral (${owningCampaignSql({ organizationId: sql`r.organization_id`, personId: sql`r.person_id`, at: sql`lm.sent_at` })}) own on true
        join lateral (
          select sq.id as sequence_id, v.id as version_id, sq.after_reply_enabled_at as enabled_at
          from sequences sq join sequence_versions v on v.sequence_id = sq.id and v.status = 'published'
          where sq.campaign_id = own.id and sq.status = 'active'
          order by v.version desc limit 1
        ) pick on true
        where r.latest_inbound_message_id is not null
          and ${startableCampaignSql({ channel: sql`own.channel`, type: sql`own.type`, status: sql`own.status`, archivedAt: sql`own.archived_at` })}
          and lm.sent_at >= pick.enabled_at - make_interval(mins => ${NEW_REPLY_MARGIN_MINUTES})
          and r.workflow_state not in ('closed', 'paused')
          and s.follow_ups = 'continue'
          and p.email is not null
          and p.lifecycle <> 'contact'
          and exists (select 1 from reply_type_picks cl where cl.message_id = r.latest_inbound_message_id and cl.expected_context_version = r.context_version and cl.status in ('auto_applied', 'accepted', 'overridden'))
          and not exists (select 1 from sequence_runs sr where sr.record_id = r.id and (sr.trigger_message_id = r.latest_inbound_message_id or sr.status in ('active', 'paused')))
          and not exists (select 1 from contact_policies cp where cp.person_id = r.person_id and cp.do_not_contact)
          and not exists (select 1 from suppression_list sl where sl.organization_id = r.organization_id and sl.email = lower(p.email))
          and (not (r.last_outbound_at is not null and r.last_inbound_at is not null and r.last_outbound_at >= r.last_inbound_at)
               or (select count(*) from sequence_steps st where st.sequence_version_id = pick.version_id) >= 2)
        order by r.last_inbound_at desc nulls last
        limit ${limit}`),
    ).map((r) => ({ organizationId: r.organization_id, recordId: r.id }));
  },

  async interruptCandidates(afterRunId, limit) {
    const rows = rowsOf<FactsRow>(
      await db.execute(factsQuery(sql`r.status in ('active', 'paused') ${afterRunId ? sql`and r.id > ${afterRunId}` : sql``}`, sql`order by r.id limit ${limit}`)),
    );
    return rows.map(toCandidate);
  },

  async interruptFactsFor(organizationId, runId) {
    const [row] = rowsOf<FactsRow>(await db.execute(factsQuery(sql`r.id = ${runId} and r.organization_id = ${organizationId} and r.status in ('active', 'paused')`)));
    return row ? toCandidate(row).facts : null;
  },

  async interrupt(organizationId, runId, reason, now) {
    await db.transaction((tx) => endRunTx(tx, { organizationId, runId, final: "interrupted", reason, now }));
  },

  async settleDrafts(now, limit) {
    const rows = rowsOf<{ id: string; organization_id: string; run_id: string }>(
      await db.execute(sql`
        select sr.id, sr.organization_id, sr.sequence_run_id as run_id
        from sequence_step_runs sr
        join sequence_runs r on r.id = sr.sequence_run_id and r.status = 'active'
        join drafts d on d.id = sr.draft_id
        where sr.status = 'awaiting_review' and d.status in ('sent', 'discarded', 'stale', 'failed')
        order by sr.updated_at limit ${limit}`),
    );
    let changed = 0;
    for (const row of rows) {
      const did = await db.transaction(async (tx) => {
        // Lock order is record, run, step run, as in `endRunTx`. A stop that committed first leaves nothing to settle.
        const [owner] = rowsOf<{ record_id: string }>(await tx.execute(sql`select record_id from sequence_runs where id = ${row.run_id} and organization_id = ${row.organization_id}`));
        if (!owner) return false;
        await tx.execute(sql`select id from records where id = ${owner.record_id} and organization_id = ${row.organization_id} for update`);
        const [live] = rowsOf<{ status: string }>(await tx.execute(sql`select status from sequence_runs where id = ${row.run_id} and organization_id = ${row.organization_id} for update`));
        if (!live || live.status !== "active") return false;
        const [sr] = rowsOf<{ id: string; run_id: string; record_id: string; position: number; attempt_count: number; draft_id: string; draft_status: string; draft_error: string | null }>(
          await tx.execute(sql`
            select sr.id, sr.sequence_run_id as run_id, r.record_id, st.position, sr.attempt_count, d.id as draft_id, d.status as draft_status, d.error as draft_error
            from sequence_step_runs sr
            join sequence_runs r on r.id = sr.sequence_run_id and r.status = 'active'
            join sequence_steps st on st.id = sr.sequence_step_id
            join drafts d on d.id = sr.draft_id
            where sr.id = ${row.id} and sr.organization_id = ${row.organization_id} and sr.status = 'awaiting_review'
            for update of sr skip locked`),
        );
        if (!sr) return false;
        if (sr.draft_status === "sent") {
          const [sent] = rowsOf<{ id: string; sent_at: Date | string }>(
            await tx.execute(sql`select id, sent_at from messages where organization_id = ${row.organization_id} and direction = 'outbound' and raw->>'draftId' = ${sr.draft_id} order by sent_at limit 1`),
          );
          if (!sent) return false;
          await tx.execute(sql`update sequence_step_runs set status = 'sent', sent_message_id = ${sent.id}, last_error = null, updated_at = ${ts(now)} where id = ${sr.id}`);
          await advanceRunTx(tx, { organizationId: row.organization_id, runId: sr.run_id, afterPosition: sr.position, from: asDate(sent.sent_at), now });
          await recordEvent(tx, { organizationId: row.organization_id, recordId: sr.record_id, type: "sequence.step_sent", actorUserId: null, to: { sequenceRunId: sr.run_id, position: sr.position, messageId: sent.id } });
        } else if (sr.draft_status === "discarded") {
          // A person discarded the draft: that step is handled, and the next waits its own delay from now.
          await tx.execute(sql`update sequence_step_runs set status = 'skipped', updated_at = ${ts(now)} where id = ${sr.id}`);
          await advanceRunTx(tx, { organizationId: row.organization_id, runId: sr.run_id, afterPosition: sr.position, from: now, now });
          await recordEvent(tx, { organizationId: row.organization_id, recordId: sr.record_id, type: "sequence.step_skipped", actorUserId: null, to: { sequenceRunId: sr.run_id, position: sr.position, reason: "draft_discarded" } });
        } else if (sr.draft_status === "stale") {
          // Superseded or outdated by a context change that did not stop the run: draft the step again, a few times.
          if (sr.attempt_count >= MAX_DRAFT_ATTEMPTS) {
            await tx.execute(sql`update sequence_step_runs set status = 'failed', last_error = 'The draft kept going stale.', updated_at = ${ts(now)} where id = ${sr.id}`);
          } else {
            await tx.execute(sql`update sequence_step_runs set status = 'scheduled', draft_id = null, due_at = ${ts(now)}, updated_at = ${ts(now)} where id = ${sr.id}`);
          }
        } else {
          await tx.execute(sql`update sequence_step_runs set status = 'failed', last_error = ${sr.draft_error ?? "The draft failed."}, updated_at = ${ts(now)} where id = ${sr.id}`);
        }
        return true;
      });
      if (did) changed += 1;
    }
    return changed;
  },

  async claimDue(workerId, now, leaseMs) {
    const expired = new Date(now.getTime() - leaseMs);
    // A step whose drafting died too many times stops retrying.
    await db.execute(sql`
      update sequence_step_runs set status = 'failed', last_error = 'Drafting did not finish.', updated_at = ${ts(now)}
      where status = 'drafting' and updated_at < ${ts(expired)} and attempt_count >= ${MAX_DRAFT_ATTEMPTS}`);
    const [claimed] = rowsOf<{ id: string; organization_id: string; attempt_count: number }>(
      await db.execute(sql`
        with pick as (
          select sr.id
          from sequence_step_runs sr
          join sequence_runs r on r.id = sr.sequence_run_id and r.organization_id = sr.organization_id
          join sequence_steps st on st.id = sr.sequence_step_id
          join records rec on rec.id = r.record_id
          join sequences fl on fl.id = r.sequence_id and fl.organization_id = r.organization_id
          left join campaigns camp on camp.id = fl.campaign_id and camp.organization_id = fl.organization_id
          where r.status = 'active'
            and ${flowRunnableSql("fl")}
            and (camp.id is null or camp.status <> 'paused')
            and st.position = r.current_step_position
            and rec.workflow_state not in ('paused', 'closed')
            and ((sr.status = 'scheduled' and sr.due_at <= ${ts(now)}) or (sr.status = 'drafting' and sr.updated_at < ${ts(expired)}))
            and (st.position = 1 or not exists (select 1 from drafts d where d.record_id = rec.id and d.status in ${PENDING_DRAFTS} and d.request->>'sequenceStepRunId' is distinct from sr.id::text))
          order by sr.due_at
          limit 1
          for update of sr skip locked
        )
        update sequence_step_runs u set status = 'drafting', attempt_count = u.attempt_count + 1, updated_at = ${ts(now)}
        from pick where u.id = pick.id
        returning u.id, u.organization_id, u.attempt_count`),
    );
    if (!claimed) return null;
    void workerId;
    const [d] = rowsOf<{
      run_id: string;
      record_id: string;
      conversation_id: string;
      sequence_version_id: string;
      trigger_message_id: string;
      step_id: string;
      step_version_id: string;
      position: number;
      name: string;
      delay_minutes: number;
      subject_template: string | null;
      body_template: string | null;
      ai_instructions: string;
      knowledge_tags: string[];
    }>(
      await db.execute(sql`
        select r.id as run_id, r.record_id, r.conversation_id, r.sequence_version_id, r.trigger_message_id,
               st.id as step_id, st.sequence_version_id as step_version_id, st.position, st.name, st.delay_minutes, st.subject_template, st.body_template, st.ai_instructions, st.knowledge_tags
        from sequence_step_runs sr join sequence_runs r on r.id = sr.sequence_run_id join sequence_steps st on st.id = sr.sequence_step_id
        where sr.id = ${claimed.id}`),
    );
    const step: ClaimedStep["step"] = {
      id: d.step_id,
      sequenceVersionId: d.step_version_id,
      position: d.position,
      stepType: stepTypeAt(d.position),
      name: d.name,
      delayMinutes: d.delay_minutes,
      subjectTemplate: d.subject_template,
      bodyTemplate: d.body_template,
      aiInstructions: d.ai_instructions,
      knowledgeTags: d.knowledge_tags ?? [],
    };
    return {
      stepRunId: claimed.id,
      organizationId: claimed.organization_id,
      attempts: claimed.attempt_count,
      run: { id: d.run_id, recordId: d.record_id, conversationId: d.conversation_id, sequenceVersionId: d.sequence_version_id, triggerMessageId: d.trigger_message_id },
      step,
      timeZone: await db.transaction((tx) => zoneOfTx(tx, claimed.organization_id)),
    };
  },

  async release(stepRunId, dueAt, now) {
    await db.execute(sql`
      update sequence_step_runs set status = 'scheduled', due_at = ${ts(dueAt)}, attempt_count = greatest(attempt_count - 1, 0), updated_at = ${ts(now)}
      where id = ${stepRunId} and status = 'drafting'`);
  },

  async failAttempt(stepRunId, error, retryAt, now) {
    if (retryAt) {
      await db.execute(sql`update sequence_step_runs set status = 'scheduled', due_at = ${ts(retryAt)}, last_error = ${error}, updated_at = ${ts(now)} where id = ${stepRunId} and status = 'drafting'`);
    } else {
      await db.execute(sql`update sequence_step_runs set status = 'failed', last_error = ${error}, updated_at = ${ts(now)} where id = ${stepRunId} and status = 'drafting'`);
    }
  },

  async openDrafts(organizationId, recordId) {
    return rowsOf<{ id: string; status: string; reply_for_message_id: string | null }>(
      await db.execute(sql`
        select d.id, d.status, d.reply_for_message_id from drafts d
        where d.organization_id = ${organizationId} and d.record_id = ${recordId} and d.status in ${PENDING_DRAFTS}
          and not exists (select 1 from sequence_step_runs sr where sr.draft_id = d.id)`),
    ).map((r) => ({ id: r.id, status: r.status, replyForMessageId: r.reply_for_message_id }));
  },

  async orphanDraft(organizationId, stepRunId) {
    const [row] = rowsOf<{ id: string }>(
      await db.execute(sql`
        select d.id from drafts d
        where d.organization_id = ${organizationId} and d.request->>'sequenceStepRunId' = ${stepRunId} and d.status in ${sqlValues(UNSENT_DRAFT_STATUSES)}
          and not exists (select 1 from sequence_step_runs sr where sr.draft_id = d.id)
        order by d.created_at desc limit 1`),
    );
    return row?.id ?? null;
  },

  async linkDraft(organizationId, stepRunId, draftId, now) {
    return db.transaction(async (tx: Tx) => {
      // Lock order is record, run, step run, as in `endRunTx`, so a stop and this link serialize.
      const [peek] = rowsOf<{ record_id: string }>(
        await tx.execute(sql`select r.record_id from sequence_step_runs sr join sequence_runs r on r.id = sr.sequence_run_id where sr.id = ${stepRunId} and sr.organization_id = ${organizationId}`),
      );
      if (!peek) return false;
      await tx.execute(sql`select id from records where id = ${peek.record_id} and organization_id = ${organizationId} for update`);
      const [sr] = rowsOf<{ id: string; record_id: string; run_status: string }>(
        await tx.execute(sql`
          select sr.id, r.record_id, r.status as run_status
          from sequence_step_runs sr join sequence_runs r on r.id = sr.sequence_run_id
          where sr.id = ${stepRunId} and sr.organization_id = ${organizationId}
          for update of r`),
      );
      if (!sr || sr.run_status !== "active") return false;
      const [locked] = rowsOf<{ id: string }>(await tx.execute(sql`select id from sequence_step_runs where id = ${stepRunId} and status = 'drafting' for update`));
      if (!locked) return false;
      // The draft must belong to the run's record. SQL only knows both sit in the organization.
      const [draft] = rowsOf<{ id: string }>(await tx.execute(sql`select id from drafts where id = ${draftId} and organization_id = ${organizationId} and record_id = ${sr.record_id}`));
      if (!draft) throw new Error("The draft does not belong to the run's record.");
      await tx.execute(sql`update sequence_step_runs set status = 'awaiting_review', draft_id = ${draftId}, last_error = null, updated_at = ${ts(now)} where id = ${stepRunId}`);
      await tx.execute(sql`
        update records set workflow_state = 'action_required', next_action_at = null
        where id = ${sr.record_id} and organization_id = ${organizationId} and workflow_state in ('waiting', 'idle')`);
      await recordEvent(tx, { organizationId, recordId: sr.record_id, type: "sequence.draft_created", actorUserId: null, to: { stepRunId, draftId } });
      return true;
    });
  },

  async retireDraft(organizationId, draftId, now) {
    await db.execute(sql`
      update drafts set status = 'stale', error = 'The follow-up sequence ended.', updated_at = ${ts(now)}
      where id = ${draftId} and organization_id = ${organizationId} and status in ${sqlValues(RETIRABLE_DRAFT_STATUSES)}`);
  },

  async knowledgeForTags(organizationId, tags) {
    return knowledgeFor(organizationId, { alwaysOnly: false, stepTags: tags, includeUnmatched: false });
  },
};
