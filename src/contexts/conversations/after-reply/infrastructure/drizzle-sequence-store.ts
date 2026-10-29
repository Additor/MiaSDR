import { and, asc, desc, eq, inArray, isNotNull, max, notExists, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, drafts, people, records, replyTypes, replyTypeSets } from "@/platform/db/schema";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { AfterReplyStore, FlowRunRow, FlowState, NewRun, RecordSequenceState, RunStore, StartFacts, StepView } from "../application/sequence-ports";
import { afterReplyFlowName, afterReplyModeOf } from "../domain/after-reply";
import { ACTIVE_RUN_STATUSES, AFTER_REPLY_OFF, assertPublishable, OPEN_STEP_STATUSES, stepsEqual, stepTypeAt, type RunStatus, type StepInput } from "../domain/sequences";
import { owningCampaignSql, startableCampaignSql, startFollowUpsSql, startReplyDraftSql } from "./after-reply-sql";
import { rowsOf } from "@/platform/db/sql-values";
import { advanceRunTx, asDate, asDateOrNull, ts } from "./sequence-run-tx";
import { endRunTx, recordEvent, runMayBecome, stepMayBecome, type Tx } from "./sequence-stop";
import { sequenceRuns, sequences, sequenceSteps, sequenceStepRuns, sequenceVersions } from "./sequences-schema";
import { publicConversationSql } from "@/platform/db/conversation-visibility";
import { RETIRABLE_DRAFT_STATUSES } from "../../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";
import type { FollowUpsRule } from "../../domain/reply-type";
import { DEFAULT_REPLY_TYPES } from "../../domain/default-reply-types";
import { stopRequestedSql } from "../../infrastructure/stop-requested-sql";
import { detectsStopRequest } from "../../domain/stop-request";
import { doNotContactSql, suppressedSql } from "@/contexts/people/infrastructure/reachability";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";

const toStepView = (r: typeof sequenceSteps.$inferSelect): StepView => ({
  id: r.id,
  sequenceVersionId: r.sequenceVersionId,
  position: r.position,
  stepType: stepTypeAt(r.position),
  name: r.name,
  delayMinutes: r.delayMinutes,
  subjectTemplate: r.subjectTemplate,
  bodyTemplate: r.bodyTemplate,
  aiInstructions: r.aiInstructions,
  knowledgeTags: r.knowledgeTags ?? [],
});

const toInput = (s: StepView): StepInput => ({
  name: s.name,
  delayMinutes: s.delayMinutes,
  subjectTemplate: s.subjectTemplate,
  bodyTemplate: s.bodyTemplate,
  aiInstructions: s.aiInstructions,
  knowledgeTags: s.knowledgeTags,
});

async function stepsOf(tx: Tx | typeof db, versionId: string): Promise<StepView[]> {
  const rows = await tx.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceVersionId, versionId)).orderBy(asc(sequenceSteps.position));
  return rows.map(toStepView);
}

async function insertSteps(tx: Tx, organizationId: string, versionId: string, steps: readonly StepInput[]) {
  if (steps.length === 0) return;
  await tx.insert(sequenceSteps).values(
    steps.map((s, index) => ({
      organizationId,
      sequenceVersionId: versionId,
      position: index + 1,
      stepType: stepTypeAt(index + 1),
      name: s.name,
      delayMinutes: s.delayMinutes,
      subjectTemplate: s.subjectTemplate,
      bodyTemplate: s.bodyTemplate,
      aiInstructions: s.aiInstructions,
      knowledgeTags: [...s.knowledgeTags],
    })),
  );
}

const versionCols = { id: sequenceVersions.id, version: sequenceVersions.version };

async function draftVersion(tx: Tx | typeof db, sequenceId: string) {
  const [row] = await tx.select(versionCols).from(sequenceVersions).where(and(eq(sequenceVersions.sequenceId, sequenceId), eq(sequenceVersions.status, "draft")));
  return row ?? null;
}

async function latestPublished(tx: Tx | typeof db, sequenceId: string) {
  const [row] = await tx
    .select(versionCols)
    .from(sequenceVersions)
    .where(and(eq(sequenceVersions.sequenceId, sequenceId), eq(sequenceVersions.status, "published")))
    .orderBy(desc(sequenceVersions.version))
    .limit(1);
  return row ?? null;
}

// The Follow-ups after a reply flow of a campaign ---------------------------------------------------------------

const OPEN_STEP_RUNS = sqlValues(OPEN_STEP_STATUSES);
const campaignCols = { id: campaigns.id, name: campaigns.name, channel: campaigns.channel, type: campaigns.type, status: campaigns.status };
const ofCampaign = (organizationId: string, campaignId: string) => and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId));
const flowOf = (organizationId: string, campaignId: string) => and(eq(sequences.campaignId, campaignId), eq(sequences.organizationId, organizationId));

export const drizzleAfterReplyStore: AfterReplyStore = {
  async state(organizationId, campaignId): Promise<FlowState | null> {
    const [campaign] = await db.select(campaignCols).from(campaigns).where(ofCampaign(organizationId, campaignId));
    if (!campaign) return null;
    const [flow] = await db.select({ id: sequences.id, status: sequences.status }).from(sequences).where(flowOf(organizationId, campaignId));
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
    const [set] = await db.select({ id: replyTypeSets.id }).from(replyTypeSets).where(and(eq(replyTypeSets.organizationId, organizationId), eq(replyTypeSets.isDefault, true)));
    if (!set) {
      return DEFAULT_REPLY_TYPES.flatMap((t, index) =>
        t.rules.followUps === "stop" ? [{ id: t.key, key: t.key, name: t.name, groupKey: t.groupKey, systemRole: t.systemRole ?? null, sortOrder: index }] : [],
      );
    }
    return db
      .select({ id: replyTypes.id, key: replyTypes.key, name: replyTypes.name, groupKey: replyTypes.groupKey, systemRole: replyTypes.systemRole, sortOrder: replyTypes.sortOrder })
      .from(replyTypes)
      .where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, set.id), eq(replyTypes.active, true), eq(replyTypes.followUps, "stop")));
  },

  async save(input) {
    return db.transaction(async (tx) => {
      // The campaign row serializes saves of one campaign. Lock order is campaign, then record, then run.
      const [campaign] = await tx.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(ofCampaign(input.organizationId, input.campaignId)).for("update");
      if (!campaign) throw new NotFoundError("Campaign not found");
      let [flow] = await tx.select({ id: sequences.id, status: sequences.status }).from(sequences).where(flowOf(input.organizationId, input.campaignId)).for("update");

      if (input.mode === "handoff") {
        if (!flow) return { stoppedRuns: 0 };
        const runs = await tx
          .select({ id: sequenceRuns.id })
          .from(sequenceRuns)
          .where(and(eq(sequenceRuns.sequenceId, flow.id), eq(sequenceRuns.organizationId, input.organizationId), inArray(sequenceRuns.status, [...ACTIVE_RUN_STATUSES])))
          .orderBy(asc(sequenceRuns.createdAt));
        if (runs.length > 0 && !input.confirmStopRuns) {
          throw new ConflictError(`${runs.length} follow-up${runs.length === 1 ? "" : "s"} in progress will stop. Confirm to switch off.`, { code: "runs_in_progress", count: runs.length });
        }
        if (flow.status !== "archived") await tx.update(sequences).set({ status: "archived", updatedAt: input.now }).where(eq(sequences.id, flow.id));
        let stopped = 0;
        for (const run of runs) {
          if (await endRunTx(tx, { organizationId: input.organizationId, runId: run.id, final: "interrupted", reason: AFTER_REPLY_OFF, now: input.now, actorUserId: input.actorUserId })) stopped += 1;
        }
        return { stoppedRuns: stopped };
      }

      if (!flow) {
        [flow] = await tx
          .insert(sequences)
          .values({ organizationId: input.organizationId, name: afterReplyFlowName(campaign.name), campaignId: input.campaignId, afterReplyEnabledAt: input.now, createdAt: input.now, updatedAt: input.now })
          .returning({ id: sequences.id, status: sequences.status });
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
          const [top] = await tx.select({ v: max(sequenceVersions.version) }).from(sequenceVersions).where(eq(sequenceVersions.sequenceId, flow.id));
          [target] = await tx
            .insert(sequenceVersions)
            .values({ organizationId: input.organizationId, sequenceId: flow.id, version: (top?.v ?? 0) + 1, status: "draft" })
            .returning(versionCols);
        }
        await tx.delete(sequenceSteps).where(and(eq(sequenceSteps.sequenceVersionId, target.id), eq(sequenceSteps.organizationId, input.organizationId)));
        await insertSteps(tx, input.organizationId, target.id, steps);
        await tx.update(sequenceVersions).set({ status: "published", publishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(sequenceVersions.id, target.id));
      }
      // Only a switch from off to on moves `after_reply_enabled_at`. Editing the steps of a flow that is already on leaves it
      // alone, so the engine's cut-off for "new replies" stays at the moment the setting was turned on.
      if (flow.status !== "active") await tx.update(sequences).set({ status: "active", afterReplyEnabledAt: input.now, updatedAt: input.now }).where(eq(sequences.id, flow.id));
      return { stoppedRuns: 0 };
    });
  },
};

/** The campaign that owns a sequence of the organization, or null for a legacy standalone sequence or an unknown id. */
export async function campaignIdOfSequence(organizationId: string, sequenceId: string): Promise<string | null> {
  const [row] = await db.select({ campaignId: sequences.campaignId }).from(sequences).where(and(eq(sequences.id, sequenceId), eq(sequences.organizationId, organizationId)));
  return row?.campaignId ?? null;
}

// Runs ------------------------------------------------------------------------------------------------

const recordLock = async (tx: Tx, organizationId: string, recordId: string) => {
  const [row] = await tx
    .select({ id: records.id, personId: records.personId, contextVersion: records.contextVersion })
    .from(records)
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)))
    .for("update");
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
    latest_body: string | null;
    dnc: boolean;
    suppressed: boolean;
    contact: boolean;
    conv_id: string | null;
    conv_record_id: string | null;
    conv_channel: string | null;
  }>(
    await exec.execute(sql`
      select r.id, r.person_id, r.reply_type_id, r.group_key, s.key as sub_key, s.name as sub_name, ${startFollowUpsSql("r", "s")} as follow_ups, ${startReplyDraftSql("r", "s")} as reply_draft, r.latest_inbound_message_id, r.last_inbound_at, r.last_outbound_at, r.context_version, r.workflow_state,
             conv.id as conv_id, conv.record_id as conv_record_id, conv.channel as conv_channel,
             p.email is not null as has_email,
             ${stopRequestedSql(sql`r.latest_inbound_message_id`)} as stop_requested,
             (select m.body_text from messages m join conversations mc on mc.id = m.conversation_id
               where m.id = r.latest_inbound_message_id and m.organization_id = r.organization_id and ${publicConversationSql("mc")}) as latest_body,
             p.lifecycle = 'contact' as contact,
             ${doNotContactSql("p")} as dnc,
             ${suppressedSql("p")} as suppressed
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
  const [stepViews, timeZone] = await Promise.all([stepsPending, organizationTimeZone(organizationId, exec)]);
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
      // A pick's flag, or the reply's own words for a reply no AI pick read (`replyAskedToStop` reads the same two facts).
      stopRequested: r.stop_requested || detectsStopRequest(r.latest_body ?? ""),
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
  const [flow] = await tx
    .select({ status: sequences.status })
    .from(sequences)
    .where(and(eq(sequences.id, run.sequenceId), eq(sequences.organizationId, run.organizationId)))
    .for("share");
  if (!flow || flow.status !== "active") throw new ConflictError("Follow-ups after a reply were switched off for this campaign.", { code: "flow_off" });
  const record = await recordLock(tx, run.organizationId, run.recordId);
  // A conversion holds this record's lock until it commits, so this read sees the committed lifecycle. The facts the
  // caller loaded earlier may predate it.
  const [owner] = await tx.select({ lifecycle: people.lifecycle }).from(people).where(and(eq(people.id, record.personId), eq(people.organizationId, run.organizationId)));
  if (owner?.lifecycle === "contact") throw new ConflictError("The person is a contact, so follow-ups do not apply.", { code: "contact" });
  const [existing] = await tx
    .select({ id: sequenceRuns.id, sequenceVersionId: sequenceRuns.sequenceVersionId, triggerMessageId: sequenceRuns.triggerMessageId, startStepPosition: sequenceRuns.startStepPosition })
    .from(sequenceRuns)
    .where(and(eq(sequenceRuns.recordId, run.recordId), eq(sequenceRuns.organizationId, run.organizationId), inArray(sequenceRuns.status, [...ACTIVE_RUN_STATUSES])))
    .for("update");
  if (existing) {
    if (!run.restart && existing.sequenceVersionId === run.sequenceVersionId && existing.triggerMessageId === run.triggerMessageId && existing.startStepPosition === run.startPosition) {
      return { runId: existing.id, created: false };
    }
    await endRunTx(tx, { organizationId: run.organizationId, runId: existing.id, final: "cancelled", reason: "replaced", now: run.now, actorUserId: run.actorUserId });
  }
  const [created] = await tx
    .insert(sequenceRuns)
    .values({
      organizationId: run.organizationId,
      recordId: run.recordId,
      conversationId: run.conversationId,
      sequenceId: run.sequenceId,
      sequenceVersionId: run.sequenceVersionId,
      replyTypeId: run.replyTypeId,
      status: "active",
      currentStepPosition: run.startPosition,
      startStepPosition: run.startPosition,
      startedBy: run.source,
      triggerMessageId: run.triggerMessageId,
      lastInboundAtStart: run.lastInboundAtStart,
    })
    .returning({ id: sequenceRuns.id });
  if (run.steps.length > 0) {
    await tx.insert(sequenceStepRuns).values(
      run.steps.map((step) => ({
        organizationId: run.organizationId,
        sequenceRunId: created.id,
        sequenceStepId: step.stepId,
        status: "scheduled" as const,
        dueAt: step.dueAt,
        expectedContextVersion: record.contextVersion,
      })),
    );
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
  loadStart: (organizationId, recordId, opts) => loadStartOn(db, organizationId, recordId, opts),
  createRun: (run) => db.transaction((tx) => createRunOn(tx, run)),

  async recordState(organizationId, recordId): Promise<RecordSequenceState | null> {
    const [rec] = await db.select({ personId: records.personId, lastInboundAt: records.lastInboundAt }).from(records).where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)));
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
      ? await db
          .select({
            id: sequenceStepRuns.id,
            position: sequenceSteps.position,
            name: sequenceSteps.name,
            status: sequenceStepRuns.status,
            dueAt: sequenceStepRuns.dueAt,
            draftId: sequenceStepRuns.draftId,
            lastError: sequenceStepRuns.lastError,
          })
          .from(sequenceStepRuns)
          .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceStepRuns.sequenceStepId))
          .where(eq(sequenceStepRuns.sequenceRunId, run.id))
          .orderBy(asc(sequenceSteps.position))
      : [];
    // The run's own campaign, else the one that most recently emailed the person.
    const [campaign] = run?.campaign_id
      ? await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(ofCampaign(organizationId, run.campaign_id))
      : rowsOf<{ id: string; name: string }>(
          await db.execute(sql`
            select own.id, own.name from (${owningCampaignSql({
              organizationId: sql`${organizationId}::uuid`,
              personId: sql`${rec.personId}::uuid`,
              at: rec.lastInboundAt ? ts(rec.lastInboundAt) : null,
            })}) own`),
        );
    let mode = afterReplyModeOf(null);
    if (campaign) {
      const [flow] = await db
        .select({
          status: sequences.status,
          // A nested builder: a single-table select writes the columns of a raw `sql` field unqualified.
          hasPublished: sql<boolean>`exists (${db
            .select({ one: sql`1` })
            .from(sequenceVersions)
            .where(and(eq(sequenceVersions.sequenceId, sequences.id), eq(sequenceVersions.status, "published")))})`,
        })
        .from(sequences)
        .where(flowOf(organizationId, campaign.id));
      mode = afterReplyModeOf(flow ? { status: flow.status, hasPublishedVersion: flow.hasPublished } : null);
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
            steps,
          }
        : null,
    };
  },

  async pause(event, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = await tx
        .select({ id: sequenceRuns.id })
        .from(sequenceRuns)
        .where(and(eq(sequenceRuns.recordId, event.recordId), eq(sequenceRuns.organizationId, event.organizationId), eq(sequenceRuns.status, "active")))
        .for("update");
      if (!run) throw new ConflictError("There is no active sequence run to pause.");
      // A draft waiting for review is retired and its step goes back to scheduled, so resuming drafts it afresh. As in
      // `endRunTx`, that covers a draft a worker wrote and has not linked yet: the pause ends the worker's claim.
      await tx
        .update(drafts)
        .set({ status: "stale", error: "The sequence was paused.", updatedAt: now })
        .where(
          and(
            eq(drafts.organizationId, event.organizationId),
            inArray(drafts.status, [...RETIRABLE_DRAFT_STATUSES]),
            or(
              inArray(
                drafts.id,
                tx
                  .select({ id: sequenceStepRuns.draftId })
                  .from(sequenceStepRuns)
                  .where(and(eq(sequenceStepRuns.sequenceRunId, run.id), isNotNull(sequenceStepRuns.draftId), inArray(sequenceStepRuns.status, ["drafting", "awaiting_review", "failed"]))),
              ),
              and(sql`${drafts.request}->>'sequenceRunId' = ${run.id}`, notExists(tx.select({ one: sql`1` }).from(sequenceStepRuns).where(eq(sequenceStepRuns.draftId, drafts.id)))),
            ),
          ),
        );
      await tx
        .update(sequenceStepRuns)
        .set({ status: "scheduled", draftId: null, claimToken: null, updatedAt: now })
        .where(and(eq(sequenceStepRuns.sequenceRunId, run.id), eq(sequenceStepRuns.organizationId, event.organizationId), stepMayBecome("scheduled")));
      await tx.update(sequenceRuns).set({ status: "paused", updatedAt: now }).where(and(eq(sequenceRuns.id, run.id), runMayBecome("paused")));
      await tx.execute(sql`update records set next_action_at = null where id = ${event.recordId} and organization_id = ${event.organizationId} and workflow_state = 'waiting'`);
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.paused", actorUserId: event.actorUserId, to: { sequenceRunId: run.id } });
    });
  },

  async resume(event, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = await tx
        .select({ id: sequenceRuns.id })
        .from(sequenceRuns)
        .where(and(eq(sequenceRuns.recordId, event.recordId), eq(sequenceRuns.organizationId, event.organizationId), eq(sequenceRuns.status, "paused")))
        .orderBy(desc(sequenceRuns.updatedAt))
        .limit(1)
        .for("update");
      if (!run) throw new ConflictError("There is no paused sequence run to resume.");
      await tx
        .update(sequenceStepRuns)
        .set({ dueAt: sql`greatest(${sequenceStepRuns.dueAt}, ${ts(now)})`, updatedAt: now })
        .where(and(eq(sequenceStepRuns.sequenceRunId, run.id), eq(sequenceStepRuns.status, "scheduled")));
      await tx.update(sequenceRuns).set({ status: "active", updatedAt: now }).where(and(eq(sequenceRuns.id, run.id), runMayBecome("active")));
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.resumed", actorUserId: event.actorUserId, to: { sequenceRunId: run.id } });
    });
  },

  async cancel(event, reason, now) {
    await db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = await tx
        .select({ id: sequenceRuns.id })
        .from(sequenceRuns)
        .where(and(eq(sequenceRuns.recordId, event.recordId), eq(sequenceRuns.organizationId, event.organizationId), inArray(sequenceRuns.status, [...ACTIVE_RUN_STATUSES])))
        .for("update");
      if (!run) throw new ConflictError("There is no sequence run to cancel.");
      await endRunTx(tx, { organizationId: event.organizationId, runId: run.id, final: "cancelled", reason, now, actorUserId: event.actorUserId });
    });
  },

  async skipStep(event, now) {
    return db.transaction(async (tx) => {
      await recordLock(tx, event.organizationId, event.recordId);
      const [run] = await tx
        .select({ id: sequenceRuns.id })
        .from(sequenceRuns)
        .where(and(eq(sequenceRuns.recordId, event.recordId), eq(sequenceRuns.organizationId, event.organizationId), eq(sequenceRuns.status, "active")))
        .for("update");
      if (!run) throw new ConflictError("There is no active sequence run.");
      const [current] = await tx
        .select({ id: sequenceStepRuns.id, position: sequenceSteps.position, status: sequenceStepRuns.status, draftId: sequenceStepRuns.draftId })
        .from(sequenceStepRuns)
        .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceStepRuns.sequenceStepId))
        .where(and(eq(sequenceStepRuns.sequenceRunId, run.id), inArray(sequenceStepRuns.status, [...OPEN_STEP_STATUSES])))
        .orderBy(asc(sequenceSteps.position))
        .limit(1)
        .for("update", { of: sequenceStepRuns });
      if (!current) throw new ConflictError("There is no pending step to skip.");
      if (current.status === "drafting") throw new ConflictError("The step is being drafted. Try again in a moment.");
      if (current.draftId) {
        await tx
          .update(drafts)
          .set({ status: "discarded", updatedAt: now })
          .where(and(eq(drafts.id, current.draftId), eq(drafts.organizationId, event.organizationId), inArray(drafts.status, [...RETIRABLE_DRAFT_STATUSES])));
      }
      await tx.update(sequenceStepRuns).set({ status: "skipped", updatedAt: now }).where(and(eq(sequenceStepRuns.id, current.id), stepMayBecome("skipped")));
      // The next step waits its own delay from now, as if the skipped message had just gone out.
      const advanced = await advanceRunTx(tx, { organizationId: event.organizationId, runId: run.id, afterPosition: current.position, from: now, now });
      await recordEvent(tx, { organizationId: event.organizationId, recordId: event.recordId, type: "sequence.step_skipped", actorUserId: event.actorUserId, from: { position: current.position }, to: advanced.next ? { position: advanced.next } : { completed: true } });
      return { skipped: current.position, next: advanced.next };
    });
  },
};
