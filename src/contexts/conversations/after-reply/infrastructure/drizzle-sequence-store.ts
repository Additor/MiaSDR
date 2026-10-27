import { sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { AfterReplyStore, FlowRunRow, FlowState, NewRun, RecordSequenceState, RunStore, StartFacts, StepView } from "../application/sequence-ports";
import { afterReplyFlowName, afterReplyModeOf } from "../domain/after-reply";
import { AFTER_REPLY_OFF, assertPublishable, assertRunTransition, stepsEqual, stepTypeAt, type RunStatus, type StepInput } from "../domain/sequences";
import { owningCampaignSql, startableCampaignSql } from "./after-reply-sql";
import { rowsOf } from "@/platform/db/sql-values";
import { advanceRunTx, asDate, asDateOrNull, ts, zoneOfTx } from "./sequence-run-tx";
import { endRunTx, recordEvent, type Tx } from "./sequence-stop";
import { publicConversationSql } from "@/platform/db/conversation-visibility";
import { RETIRABLE_DRAFT_STATUSES } from "../../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";
import type { FollowUpsRule, SystemRole } from "../../domain/reply-type";
import { DEFAULT_REPLY_TYPES } from "../../domain/default-reply-types";
import { stopRequestedSql } from "../../infrastructure/stop-requested-sql";

interface StepRow {
  id: string;
  sequence_version_id: string;
  position: number;
  step_type: string;
  name: string;
  delay_minutes: number;
  subject_template: string | null;
  body_template: string | null;
  ai_instructions: string;
  knowledge_tags: string[];
}

const toStepView = (r: StepRow): StepView => ({
  id: r.id,
  sequenceVersionId: r.sequence_version_id,
  position: r.position,
  stepType: stepTypeAt(r.position),
  name: r.name,
  delayMinutes: r.delay_minutes,
  subjectTemplate: r.subject_template,
  bodyTemplate: r.body_template,
  aiInstructions: r.ai_instructions,
  knowledgeTags: r.knowledge_tags ?? [],
});

const toInput = (s: StepView): StepInput => ({
  name: s.name,
  delayMinutes: s.delayMinutes,
  subjectTemplate: s.subjectTemplate,
  bodyTemplate: s.bodyTemplate,
  aiInstructions: s.aiInstructions,
  knowledgeTags: s.knowledgeTags,
});

const tagArray = (tags: string[]) => sql`${`{${tags.map((t) => `"${t.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`}::text[]`;

async function stepsOf(tx: Tx | typeof db, versionId: string): Promise<StepView[]> {
  return rowsOf<StepRow>(
    await tx.execute(sql`
      select id, sequence_version_id, position, step_type, name, delay_minutes, subject_template, body_template, ai_instructions, knowledge_tags
      from sequence_steps where sequence_version_id = ${versionId} order by position`),
  ).map(toStepView);
}

async function insertSteps(tx: Tx, organizationId: string, versionId: string, steps: readonly StepInput[]) {
  for (const [index, s] of steps.entries()) {
    await tx.execute(sql`
      insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, subject_template, body_template, ai_instructions, knowledge_tags)
      values (${organizationId}, ${versionId}, ${index + 1}, ${stepTypeAt(index + 1)}, ${s.name}, ${s.delayMinutes}, ${s.subjectTemplate}, ${s.bodyTemplate}, ${s.aiInstructions}, ${tagArray(s.knowledgeTags)})`);
  }
}

async function draftVersion(tx: Tx | typeof db, sequenceId: string) {
  const [row] = rowsOf<{ id: string; version: number }>(await tx.execute(sql`select id, version from sequence_versions where sequence_id = ${sequenceId} and status = 'draft'`));
  return row ?? null;
}

async function latestPublished(tx: Tx | typeof db, sequenceId: string) {
  const [row] = rowsOf<{ id: string; version: number }>(
    await tx.execute(sql`select id, version from sequence_versions where sequence_id = ${sequenceId} and status = 'published' order by version desc limit 1`),
  );
  return row ?? null;
}

// The After a reply flow of a campaign ---------------------------------------------------------------

const OPEN_STEP_RUNS = sql`('scheduled', 'drafting', 'awaiting_review', 'failed')`;

export const drizzleAfterReplyStore: AfterReplyStore = {
  async state(organizationId, campaignId): Promise<FlowState | null> {
    const [campaign] = rowsOf<{ id: string; name: string; channel: string; type: string; status: string }>(
      await db.execute(sql`select id, name, channel, type, status from campaigns where id = ${campaignId} and organization_id = ${organizationId}`),
    );
    if (!campaign) return null;
    const [flow] = rowsOf<{ id: string; status: "active" | "archived" }>(
      await db.execute(sql`select id, status from sequences where campaign_id = ${campaignId} and organization_id = ${organizationId}`),
    );
    if (!flow) return { campaign, flow: null, published: null, steps: [], inProgress: [], earlierVersionCount: 0 };
    const published = await latestPublished(db, flow.id);
    const draft = published ? null : await draftVersion(db, flow.id);
    const shown = published ?? draft;
    const rows = rowsOf<{
      run_id: string;
      record_id: string;
      conversation_id: string;
      person_name: string | null;
      status: RunStatus;
      current_step_position: number;
      version: number;
      total_steps: number;
      next_due: Date | string | null;
    }>(
      await db.execute(sql`
        select r.id as run_id, r.record_id, r.conversation_id, coalesce(p.full_name, p.first_name) as person_name, r.status, r.current_step_position, v.version,
               (select count(*)::int from sequence_steps st where st.sequence_version_id = r.sequence_version_id) as total_steps,
               (select sr.due_at from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id
                 where sr.sequence_run_id = r.id and st.position = r.current_step_position and sr.status in ${OPEN_STEP_RUNS} limit 1) as next_due
        from sequence_runs r
        join sequence_versions v on v.id = r.sequence_version_id
        join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
        join people p on p.id = rec.person_id and p.organization_id = r.organization_id
        where r.organization_id = ${organizationId} and r.sequence_id = ${flow.id} and r.status in ('active', 'paused')
        order by r.created_at desc, r.id`),
    );
    const inProgress: FlowRunRow[] = rows.map((r) => ({
      runId: r.run_id,
      recordId: r.record_id,
      conversationId: r.conversation_id,
      personName: r.person_name,
      status: r.status,
      currentStep: r.current_step_position,
      totalSteps: r.total_steps,
      nextDueAt: asDateOrNull(r.next_due),
      versionNumber: r.version,
    }));
    return {
      campaign,
      flow,
      published: published ? { version: published.version } : null,
      steps: shown ? await stepsOf(db, shown.id) : [],
      inProgress,
      earlierVersionCount: published ? inProgress.filter((r) => r.versionNumber < published.version).length : 0,
    };
  },

  // A read writes nothing. A fresh organization has no reply types until its first reply or Settings seeds the default
  // set, so the list comes from `DEFAULT_REPLY_TYPES`, with the rules and order the seed writes, keyed by type key.
  async stopReplyTypes(organizationId) {
    const [set] = rowsOf<{ id: string }>(await db.execute(sql`select id from reply_type_sets where organization_id = ${organizationId} and is_default`));
    if (!set) {
      return DEFAULT_REPLY_TYPES.flatMap((t, index) =>
        t.rules.followUps === "stop" ? [{ id: t.key, key: t.key, name: t.name, groupKey: t.groupKey, systemRole: t.systemRole ?? null, sortOrder: index }] : [],
      );
    }
    const rows = rowsOf<{ id: string; key: string; name: string; group_key: string; system_role: SystemRole | null; sort_order: number }>(
      await db.execute(sql`
        select rt.id, rt.key, rt.name, rt.group_key, rt.system_role, rt.sort_order
        from reply_types rt
        where rt.organization_id = ${organizationId} and rt.reply_type_set_id = ${set.id} and rt.active and rt.follow_ups = 'stop'`),
    );
    return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, groupKey: r.group_key, systemRole: r.system_role, sortOrder: r.sort_order }));
  },

  async save(input) {
    return db.transaction(async (tx) => {
      // The campaign row serializes saves of one campaign. Lock order is campaign, then record, then run.
      const [campaign] = rowsOf<{ id: string; name: string }>(
        await tx.execute(sql`select id, name from campaigns where id = ${input.campaignId} and organization_id = ${input.organizationId} for update`),
      );
      if (!campaign) throw new NotFoundError("Campaign not found");
      let [flow] = rowsOf<{ id: string; status: string }>(
        await tx.execute(sql`select id, status from sequences where campaign_id = ${input.campaignId} and organization_id = ${input.organizationId} for update`),
      );

      if (input.mode === "handoff") {
        if (!flow) return { stoppedRuns: 0 };
        const runs = rowsOf<{ id: string }>(
          await tx.execute(sql`select id from sequence_runs where sequence_id = ${flow.id} and organization_id = ${input.organizationId} and status in ('active', 'paused') order by created_at`),
        );
        if (runs.length > 0 && !input.confirmStopRuns) {
          throw new ConflictError(`${runs.length} follow-up${runs.length === 1 ? "" : "s"} in progress will stop. Confirm to switch off.`, { code: "runs_in_progress", count: runs.length });
        }
        if (flow.status !== "archived") await tx.execute(sql`update sequences set status = 'archived', updated_at = ${ts(input.now)} where id = ${flow.id}`);
        let stopped = 0;
        for (const run of runs) {
          if (await endRunTx(tx, { organizationId: input.organizationId, runId: run.id, final: "interrupted", reason: AFTER_REPLY_OFF, now: input.now, actorUserId: input.actorUserId })) stopped += 1;
        }
        return { stoppedRuns: stopped };
      }

      if (!flow) {
        [flow] = rowsOf<{ id: string; status: string }>(
          await tx.execute(sql`
            insert into sequences (organization_id, name, campaign_id, after_reply_enabled_at, created_at, updated_at) values (${input.organizationId}, ${afterReplyFlowName(campaign.name)}, ${input.campaignId}, ${ts(input.now)}, ${ts(input.now)}, ${ts(input.now)})
            returning id, status`),
        );
      }
      const published = await latestPublished(tx, flow.id);
      const draft = await draftVersion(tx, flow.id);
      let steps = input.steps;
      if (!steps) {
        const source = published ?? draft;
        steps = source ? (await stepsOf(tx, source.id)).map(toInput) : [];
      }
      assertPublishable(steps);

      const unchanged = published !== null && stepsEqual(steps, (await stepsOf(tx, published.id)).map(toInput));
      if (!unchanged) {
        // Only a draft is ever edited, then frozen by publishing. Runs in progress keep the version they started on.
        let target = draft;
        if (!target) {
          const [max] = rowsOf<{ v: number }>(await tx.execute(sql`select coalesce(max(version), 0)::int as v from sequence_versions where sequence_id = ${flow.id}`));
          [target] = rowsOf<{ id: string; version: number }>(
            await tx.execute(sql`insert into sequence_versions (organization_id, sequence_id, version, status) values (${input.organizationId}, ${flow.id}, ${max.v + 1}, 'draft') returning id, version`),
          );
        }
        await tx.execute(sql`delete from sequence_steps where sequence_version_id = ${target.id} and organization_id = ${input.organizationId}`);
        await insertSteps(tx, input.organizationId, target.id, steps);
        await tx.execute(sql`update sequence_versions set status = 'published', published_at = now(), updated_at = now() where id = ${target.id}`);
      }
      // Only a switch from off to on moves `after_reply_enabled_at`. Editing the steps of a flow that is already on leaves it
      // alone, so the engine's cut-off for "new replies" stays at the moment the setting was turned on.
      if (flow.status !== "active") await tx.execute(sql`update sequences set status = 'active', after_reply_enabled_at = ${ts(input.now)}, updated_at = ${ts(input.now)} where id = ${flow.id}`);
      return { stoppedRuns: 0 };
    });
  },
};

/** The campaign that owns a sequence of the organization, or null for a legacy standalone sequence or an unknown id. */
export async function campaignIdOfSequence(organizationId: string, sequenceId: string): Promise<string | null> {
  const [row] = rowsOf<{ campaign_id: string | null }>(await db.execute(sql`select campaign_id from sequences where id = ${sequenceId} and organization_id = ${organizationId}`));
  return row?.campaign_id ?? null;
}

// Runs ------------------------------------------------------------------------------------------------

const recordLock = async (tx: Tx, organizationId: string, recordId: string) => {
  const [row] = rowsOf<{ id: string; person_id: string; context_version: number; workflow_state: string }>(
    await tx.execute(sql`select id, person_id, context_version, workflow_state from records where id = ${recordId} and organization_id = ${organizationId} for update`),
  );
  if (!row) throw new NotFoundError("Reply handling not found");
  return row;
};

/** Reads what a run start needs. `exec` is the database or the caller's transaction. */
export async function loadStartOn(
  exec: Tx | typeof db,
  organizationId: string,
  recordId: string,
  opts: { conversationId?: string },
): Promise<StartFacts | null> {
  const [r] = rowsOf<{
    id: string;
    person_id: string;
    reply_type_id: string | null;
    group_key: string | null;
    sub_key: string | null;
    sub_name: string | null;
    follow_ups: FollowUpsRule | null;
    reply_draft: boolean | null;
    latest_inbound_message_id: string | null;
    last_inbound_at: Date | string | null;
    last_outbound_at: Date | string | null;
    context_version: number;
    workflow_state: string;
    has_email: boolean;
    stop_requested: boolean;
    dnc: boolean;
    suppressed: boolean;
    contact: boolean;
    conv_id: string | null;
    conv_record_id: string | null;
    conv_channel: string | null;
  }>(
    await exec.execute(sql`
      select r.id, r.person_id, r.reply_type_id, r.group_key, s.key as sub_key, s.name as sub_name, s.follow_ups, s.reply_draft, r.latest_inbound_message_id, r.last_inbound_at, r.last_outbound_at, r.context_version, r.workflow_state,
             conv.id as conv_id, conv.record_id as conv_record_id, conv.channel as conv_channel,
             p.email is not null as has_email,
             ${stopRequestedSql(sql`r.latest_inbound_message_id`)} as stop_requested,
             p.lifecycle = 'contact' as contact,
             exists (select 1 from contact_policies cp where cp.person_id = r.person_id and cp.organization_id = r.organization_id and cp.do_not_contact) as dnc,
             exists (select 1 from suppression_list sl where sl.organization_id = r.organization_id and sl.email = lower(p.email)) as suppressed
      from records r
      join people p on p.id = r.person_id and p.organization_id = r.organization_id
      left join reply_types s on s.id = r.reply_type_id
      left join lateral (
        select c.id, c.record_id, c.channel from conversations c
        where c.organization_id = ${organizationId} and ${publicConversationSql("c")}
          and c.id = ${opts.conversationId ? sql`${opts.conversationId}::uuid` : sql`(select m.conversation_id from messages m where m.id = r.latest_inbound_message_id and m.organization_id = ${organizationId})`}
      ) conv on true
      where r.id = ${recordId} and r.organization_id = ${organizationId}`),
  );
  if (!r) return null;
  const conv = r.conv_id && r.conv_record_id && r.conv_channel ? { id: r.conv_id, record_id: r.conv_record_id, channel: r.conv_channel } : undefined;

  // The campaign that most recently emailed the person owns the conversation. Its active flow, if any, runs.
  let selection: StartFacts["selection"] = null;
  let stepsPending: Promise<StepView[]> = Promise.resolve([]);
  let owner: StartFacts["owner"] = null;
  let flowFacts: StartFacts["flow"] = null;
  if (r.latest_inbound_message_id) {
    // The owner, its flow and the flow's newest published version come in one query.
    const [found] = rowsOf<{
      id: string; name: string; channel: string; type: string; status: string; archived: boolean; startable: boolean;
      flow_id: string | null; flow_status: "active" | "archived" | null; version_id: string | null;
    }>(
      await exec.execute(sql`
        select own.id, own.name, own.channel, own.type, own.status, own.archived_at is not null as archived,
               (${startableCampaignSql({ channel: sql`own.channel`, type: sql`own.type`, status: sql`own.status`, archivedAt: sql`own.archived_at` })}) as startable,
               fl.id as flow_id, fl.status as flow_status, ver.id as version_id
        from (${owningCampaignSql({
          organizationId: sql`${organizationId}::uuid`,
          personId: sql`${r.person_id}::uuid`,
          at: r.last_inbound_at ? ts(asDate(r.last_inbound_at)) : null,
        })}) own
        left join sequences fl on fl.campaign_id = own.id and fl.organization_id = ${organizationId}
        left join lateral (
          select v.id from sequence_versions v where v.sequence_id = fl.id and v.status = 'published' order by v.version desc limit 1
        ) ver on true`),
    );
    if (found) {
      owner = { id: found.id, name: found.name, channel: found.channel, type: found.type, status: found.status, archived: found.archived };
      flowFacts = found.flow_id && found.flow_status ? { status: found.flow_status, hasPublished: found.version_id !== null } : null;
      if (found.startable && found.flow_id && found.flow_status === "active" && found.version_id) {
        selection = { sequenceId: found.flow_id, sequenceVersionId: found.version_id, campaignId: found.id };
        stepsPending = stepsOf(exec, found.version_id);
      }
    }
  }
  // The steps and the zone do not depend on each other.
  const [stepViews, timeZone] = await Promise.all([stepsPending, zoneOfTx(exec as Tx, organizationId)]);
  const steps: StartFacts["steps"] = stepViews.map((x) => ({ id: x.id, sequenceVersionId: x.sequenceVersionId, position: x.position, delayMinutes: x.delayMinutes }));

  return {
    organizationId,
    record: {
      id: r.id,
      personId: r.person_id,
      replyTypeId: r.reply_type_id,
      groupKey: r.group_key,
      replyTypeKey: r.sub_key,
      replyTypeName: r.sub_name,
      followUps: r.follow_ups,
      replyDraft: r.reply_draft,
      latestInboundMessageId: r.latest_inbound_message_id,
      lastInboundAt: asDateOrNull(r.last_inbound_at),
      lastOutboundAt: asDateOrNull(r.last_outbound_at),
      contextVersion: r.context_version,
      workflowState: r.workflow_state,
      hasEmail: r.has_email,
      stopRequested: r.stop_requested,
    },
    doNotContact: r.dnc,
    suppressed: r.suppressed,
    contact: r.contact,
    owner,
    flow: flowFacts,
    conversation: conv ? { id: conv.id, recordId: conv.record_id, channel: conv.channel } : null,
    selection,
    steps,
    timeZone,
  };
}

/** Starts a run inside the caller's transaction. An active run of the record ends as `replaced` first. */
export async function createRunOn(tx: Tx, run: NewRun): Promise<{ runId: string; created: boolean }> {
  // The flow row is the lock `save` takes for update. Taking it shared first makes a switch-off wait for this run and
  // count it, and a run that starts after the switch-off stops here instead of starting on an archived flow.
  const [flow] = rowsOf<{ status: string }>(await tx.execute(sql`select status from sequences where id = ${run.sequenceId} and organization_id = ${run.organizationId} for share`));
  if (!flow || flow.status !== "active") throw new ConflictError("After a reply was switched off for this campaign.", { code: "flow_off" });
  const record = await recordLock(tx, run.organizationId, run.recordId);
  // A conversion holds this record's lock until it commits, so this read sees the committed lifecycle. The facts the
  // caller loaded earlier may predate it.
  const [owner] = rowsOf<{ lifecycle: string }>(await tx.execute(sql`select lifecycle from people where id = ${record.person_id} and organization_id = ${run.organizationId}`));
  if (owner?.lifecycle === "contact") throw new ConflictError("The person is a contact, so follow-ups do not apply.", { code: "contact" });
  const [existing] = rowsOf<{ id: string; sequence_version_id: string; trigger_message_id: string; start_step_position: number }>(
    await tx.execute(sql`select id, sequence_version_id, trigger_message_id, start_step_position from sequence_runs where record_id = ${run.recordId} and organization_id = ${run.organizationId} and status in ('active', 'paused') for update`),
  );
  if (existing) {
    if (!run.restart && existing.sequence_version_id === run.sequenceVersionId && existing.trigger_message_id === run.triggerMessageId && existing.start_step_position === run.startPosition) {
      return { runId: existing.id, created: false };
    }
    await endRunTx(tx, { organizationId: run.organizationId, runId: existing.id, final: "cancelled", reason: "replaced", now: run.now, actorUserId: run.actorUserId });
  }
  const [created] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, reply_type_id, status, current_step_position, start_step_position, started_by, trigger_message_id, last_inbound_at_start)
      values (${run.organizationId}, ${run.recordId}, ${run.conversationId}, ${run.sequenceId}, ${run.sequenceVersionId}, ${run.replyTypeId}, 'active', ${run.startPosition}, ${run.startPosition}, ${run.source}, ${run.triggerMessageId}, ${ts(run.lastInboundAtStart)})
      returning id`),
  );
  for (const step of run.steps) {
    await tx.execute(sql`
      insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, expected_context_version)
      values (${run.organizationId}, ${created.id}, ${step.stepId}, 'scheduled', ${ts(step.dueAt)}, ${record.context_version})`);
  }
  const first = run.steps.find((s) => s.position === run.startPosition);
  if (first) await tx.execute(sql`update records set next_action_at = ${ts(first.dueAt)} where id = ${run.recordId} and organization_id = ${run.organizationId} and workflow_state in ('waiting', 'idle')`);
  await recordEvent(tx, {
    organizationId: run.organizationId,
    recordId: run.recordId,
    type: "sequence.started",
    actorUserId: run.source === "human_override" ? run.actorUserId : null,
    from: existing ? { sequenceRunId: existing.id, status: "cancelled" } : null,
    to: { sequenceRunId: created.id, sequenceId: run.sequenceId, sequenceVersionId: run.sequenceVersionId, startStepPosition: run.startPosition },
  });
  return { runId: created.id, created: true };

}

export const drizzleRunStore: RunStore = {
  async timeZone(organizationId) {
    return db.transaction((tx) => zoneOfTx(tx, organizationId));
  },

  loadStart: (organizationId, recordId, opts) => loadStartOn(db, organizationId, recordId, opts),
  createRun: (run) => db.transaction((tx) => createRunOn(tx, run)),

  async recordState(organizationId, recordId): Promise<RecordSequenceState | null> {
    const [rec] = rowsOf<{ person_id: string; last_inbound_at: Date | string | null }>(
      await db.execute(sql`select person_id, last_inbound_at from records where id = ${recordId} and organization_id = ${organizationId}`),
    );
    if (!rec) return null;
    const [run] = rowsOf<{
      id: string;
      status: RunStatus;
      campaign_id: string | null;
      version: number;
      current_step_position: number;
      total_steps: number;
      started_by: "ai_assignment" | "human_override";
      created_at: Date | string;
      ended_reason: string | null;
    }>(
      await db.execute(sql`
        select r.id, r.status, q.campaign_id, v.version, r.current_step_position, r.started_by, r.created_at,
               (select count(*)::int from sequence_steps st where st.sequence_version_id = r.sequence_version_id) as total_steps,
               (select ev.meta->>'reason' from events ev
                 where ev.organization_id = r.organization_id and ev.record_id = r.record_id and ev.event_type in ('sequence.interrupted', 'sequence.cancelled')
                   and ev.to_data->>'sequenceRunId' = r.id::text
                 order by ev.created_at desc limit 1) as ended_reason
        from sequence_runs r join sequences q on q.id = r.sequence_id join sequence_versions v on v.id = r.sequence_version_id
        where r.record_id = ${recordId} and r.organization_id = ${organizationId}
        order by (r.status in ('active', 'paused')) desc, r.created_at desc limit 1`),
    );
    const steps = run
      ? rowsOf<{ id: string; position: number; name: string; status: string; due_at: Date | string; draft_id: string | null; last_error: string | null }>(
          await db.execute(sql`
            select sr.id, st.position, st.name, sr.status, sr.due_at, sr.draft_id, sr.last_error
            from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id
            where sr.sequence_run_id = ${run.id} order by st.position`),
        )
      : [];
    // The run's own campaign, else the one that most recently emailed the person.
    const [campaign] = rowsOf<{ id: string; name: string }>(
      run?.campaign_id
        ? await db.execute(sql`select id, name from campaigns where id = ${run.campaign_id} and organization_id = ${organizationId}`)
        : await db.execute(sql`
            select own.id, own.name from (${owningCampaignSql({
              organizationId: sql`${organizationId}::uuid`,
              personId: sql`${rec.person_id}::uuid`,
              at: rec.last_inbound_at ? ts(asDate(rec.last_inbound_at)) : null,
            })}) own`),
    );
    let mode = afterReplyModeOf(null);
    if (campaign) {
      const [flow] = rowsOf<{ status: string; has_published: boolean }>(
        await db.execute(sql`
          select q.status, exists (select 1 from sequence_versions v where v.sequence_id = q.id and v.status = 'published') as has_published
          from sequences q where q.campaign_id = ${campaign.id} and q.organization_id = ${organizationId}`),
      );
      mode = afterReplyModeOf(flow ? { status: flow.status, hasPublishedVersion: flow.has_published } : null);
    }
    return {
      recordId,
      campaign: campaign ? { id: campaign.id, name: campaign.name, mode } : null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            version: run.version,
            currentStepPosition: run.current_step_position,
            totalSteps: run.total_steps,
            startedBy: run.started_by,
            createdAt: asDate(run.created_at),
            endedReason: run.status === "interrupted" || run.status === "cancelled" ? run.ended_reason : null,
            steps: steps.map((x) => ({ id: x.id, position: x.position, name: x.name, status: x.status as never, dueAt: asDate(x.due_at), draftId: x.draft_id, lastError: x.last_error })),
          }
        : null,
    };
  },

  async pause(event, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = rowsOf<{ id: string; status: "active" }>(
        await tx.execute(sql`select id, status from sequence_runs where record_id = ${event.recordId} and organization_id = ${event.organizationId} and status = 'active' for update`),
      );
      if (!run) throw new ConflictError("There is no active sequence run to pause.");
      assertRunTransition("active", "paused");
      // A draft waiting for review is retired and its step goes back to scheduled, so resuming drafts it afresh.
      await tx.execute(sql`
        update drafts set status = 'stale', error = 'The sequence was paused.', updated_at = ${ts(now)}
        where organization_id = ${event.organizationId} and status in ${sqlValues(RETIRABLE_DRAFT_STATUSES)}
          and id in (select draft_id from sequence_step_runs where sequence_run_id = ${run.id} and draft_id is not null and status in ('drafting', 'awaiting_review', 'failed'))`);
      await tx.execute(sql`
        update sequence_step_runs set status = 'scheduled', draft_id = null, updated_at = ${ts(now)}
        where sequence_run_id = ${run.id} and organization_id = ${event.organizationId} and status in ('drafting', 'awaiting_review', 'failed')`);
      await tx.execute(sql`update sequence_runs set status = 'paused', updated_at = ${ts(now)} where id = ${run.id}`);
      await tx.execute(sql`update records set next_action_at = null where id = ${event.recordId} and organization_id = ${event.organizationId} and workflow_state = 'waiting'`);
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.paused", actorUserId: event.actorUserId, to: { sequenceRunId: run.id } });
    });
  },

  async resume(event, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = rowsOf<{ id: string }>(
        await tx.execute(sql`select id from sequence_runs where record_id = ${event.recordId} and organization_id = ${event.organizationId} and status = 'paused' order by updated_at desc limit 1 for update`),
      );
      if (!run) throw new ConflictError("There is no paused sequence run to resume.");
      assertRunTransition("paused", "active");
      await tx.execute(sql`update sequence_step_runs set due_at = greatest(due_at, ${ts(now)}), updated_at = ${ts(now)} where sequence_run_id = ${run.id} and status = 'scheduled'`);
      await tx.execute(sql`update sequence_runs set status = 'active', updated_at = ${ts(now)} where id = ${run.id}`);
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.resumed", actorUserId: event.actorUserId, to: { sequenceRunId: run.id } });
    });
  },

  async cancel(event, reason, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = rowsOf<{ id: string }>(
        await tx.execute(sql`select id from sequence_runs where record_id = ${event.recordId} and organization_id = ${event.organizationId} and status in ('active', 'paused') for update`),
      );
      if (!run) throw new ConflictError("There is no sequence run to cancel.");
      await endRunTx(tx, { organizationId: event.organizationId, runId: run.id, final: "cancelled", reason, now, actorUserId: event.actorUserId });
    });
  },

  async skipStep(event, now) {
    return db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = rowsOf<{ id: string }>(
        await tx.execute(sql`select id from sequence_runs where record_id = ${event.recordId} and organization_id = ${event.organizationId} and status = 'active' for update`),
      );
      if (!run) throw new ConflictError("There is no active sequence run.");
      const [current] = rowsOf<{ id: string; position: number; status: string; draft_id: string | null }>(
        await tx.execute(sql`
          select sr.id, st.position, sr.status, sr.draft_id from sequence_step_runs sr join sequence_steps st on st.id = sr.sequence_step_id
          where sr.sequence_run_id = ${run.id} and sr.status in ('scheduled', 'drafting', 'awaiting_review', 'failed') order by st.position limit 1 for update of sr`),
      );
      if (!current) throw new ConflictError("There is no pending step to skip.");
      if (current.status === "drafting") throw new ConflictError("The step is being drafted. Try again in a moment.");
      if (current.draft_id) {
        await tx.execute(sql`update drafts set status = 'discarded', updated_at = ${ts(now)} where id = ${current.draft_id} and organization_id = ${event.organizationId} and status in ${sqlValues(RETIRABLE_DRAFT_STATUSES)}`);
      }
      await tx.execute(sql`update sequence_step_runs set status = 'skipped', updated_at = ${ts(now)} where id = ${current.id}`);
      // The next step waits its own delay from now, as if the skipped message had just gone out.
      const advanced = await advanceRunTx(tx, { organizationId: event.organizationId, runId: run.id, afterPosition: current.position, from: now, now });
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.step_skipped", actorUserId: event.actorUserId, from: { position: current.position }, to: advanced.next ? { position: advanced.next } : { completed: true } });
      return { skipped: current.position, next: advanced.next };
    });
  },
};
