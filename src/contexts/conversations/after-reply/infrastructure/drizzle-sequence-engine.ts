import { and, asc, desc, eq, inArray, lt, gte, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/platform/db/client";
import { campaigns, drafts, messages, records } from "@/platform/db/schema";
import type { ClaimedStep, InterruptCandidate, LateOutcome, LinkOutcome, SequenceEngineStore } from "../application/sequence-ports";
import { ACTIVE_RUN_STATUSES, MAX_DRAFT_ATTEMPTS, STEP_FROM, stepTypeAt, type InterruptFacts, type StepRunStatus } from "../domain/sequences";
import { NEW_REPLY_MARGIN_MINUTES } from "../domain/after-reply";
import type { FollowUpsRule } from "../../domain/reply-type";
import { flowRunnableSql, owningCampaignSql, startableCampaignSql, startFollowUpsSql, startReplyDraftSql } from "./after-reply-sql";
import { rowsOf } from "@/platform/db/sql-values";
import { heldBy, NEW_CLAIM_TOKEN } from "@/platform/db/claim";
import { advanceRunTx, StepMovedError, ts } from "./sequence-run-tx";
import { endRunTx, lockRecordTx, recordEvent, stepMayBecome, type Tx } from "./sequence-stop";
import { sequenceRuns, sequences, sequenceSteps, sequenceStepRuns } from "./sequences-schema";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { knowledgeFor } from "../../infrastructure/thread-context";
import { insertDraftTx } from "../../infrastructure/reply-store-drafts";
import { stopRequestedSql } from "../../infrastructure/stop-requested-sql";
import { PENDING_DRAFT_STATUSES, RETIRABLE_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES } from "../../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";
import { doNotContactSql, suppressedSql } from "@/contexts/people/infrastructure/reachability";

const PENDING_DRAFTS = sqlValues(PENDING_DRAFT_STATUSES);
/** Run statuses that have not ended. A paused run gives its steps back; an ended one stops them. */
const LIVE_RUN: readonly string[] = ACTIVE_RUN_STATUSES;

/** The fence of a step run settle: the step is still drafting under this claim. */
const heldStep = (claim: ClaimedStep) =>
  and(
    eq(sequenceStepRuns.id, claim.stepRunId),
    eq(sequenceStepRuns.organizationId, claim.organizationId),
    eq(sequenceStepRuns.status, "drafting"),
    heldBy("sequence_step_runs", claim, "attempt_count"),
  );

/** The draft no step run links yet. */
const unlinked = (tx: Tx | typeof db) => notExists(tx.select({ one: sql`1` }).from(sequenceStepRuns).where(eq(sequenceStepRuns.draftId, drafts.id)));
/** The draft a worker wrote for this step run, found by its request. */
const writtenFor = (stepRunId: string) => sql`${drafts.request}->>'sequenceStepRunId' = ${stepRunId}`;

/** Retires `draftId` when it was written for the claim's step run, no step run links it, and no send touched it. */
const retireStepDraft = (tx: Tx, claim: ClaimedStep, draftId: string, error: string, now: Date) =>
  tx
    .update(drafts)
    .set({ status: "stale", error, updatedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.organizationId, claim.organizationId),
        writtenFor(claim.stepRunId),
        inArray(drafts.status, [...RETIRABLE_DRAFT_STATUSES]),
        unlinked(tx),
      ),
    );

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
         ${doNotContactSql("p")} as dnc,
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

/**
 * The statuses the claim takes a step from: `scheduled` (`STEP_FROM.drafting`), and `drafting` past its lease. The
 * lease takeover moves `drafting` to `drafting`, the one move outside the transition table.
 */
const CLAIMABLE: readonly StepRunStatus[] = [...STEP_FROM.drafting, "drafting"];

/**
 * The claim of `claimDue` without its expiry sweep: one due step, or one whose lease ran out with attempts left, now
 * drafting under a fresh token. `organizationId` keeps a test's claim inside its fixture; the job claims across
 * organizations.
 */
export async function takeDueStep(now: Date, expired: Date, organizationId?: string) {
  const sr = alias(sequenceStepRuns, "sr");
  const r = alias(sequenceRuns, "r");
  const st = alias(sequenceSteps, "st");
  const rec = alias(records, "rec");
  const fl = alias(sequences, "fl");
  const camp = alias(campaigns, "camp");
  const d = alias(drafts, "d");
  const u = alias(sequenceStepRuns, "u");
  const [claimed] = rowsOf<{ id: string; organization_id: string; attempt_count: number; claim_token: string }>(
    await db.execute(sql`
      with pick as (
        select ${sr.id}
        from ${sequenceStepRuns} sr
        join ${sequenceRuns} r on ${r.id} = ${sr.sequenceRunId} and ${r.organizationId} = ${sr.organizationId}
        join ${sequenceSteps} st on ${st.id} = ${sr.sequenceStepId}
        join ${records} rec on ${rec.id} = ${r.recordId}
        join ${sequences} fl on ${fl.id} = ${r.sequenceId} and ${fl.organizationId} = ${r.organizationId}
        left join ${campaigns} camp on ${camp.id} = ${fl.campaignId} and ${camp.organizationId} = ${fl.organizationId}
        where ${r.status} = 'active' ${organizationId ? sql`and ${sr.organizationId} = ${organizationId}` : sql``}
          and ${flowRunnableSql("fl")}
          and (${camp.id} is null or ${camp.status} <> 'paused')
          and ${st.position} = ${r.currentStepPosition}
          and ${rec.workflowState} not in ('paused', 'closed')
          -- A step drafting past its lease with every attempt used is never taken over: the sweep in claimDue fails it.
          and ((${sr.status} = 'scheduled' and ${sr.dueAt} <= ${ts(now)})
               or (${sr.status} = 'drafting' and ${sr.updatedAt} < ${ts(expired)} and ${sr.attemptCount} < ${MAX_DRAFT_ATTEMPTS}))
          and (${st.position} = 1 or not exists (
                select 1 from ${drafts} d
                where ${d.recordId} = ${rec.id} and ${d.status} in ${PENDING_DRAFTS} and ${d.request}->>'sequenceStepRunId' is distinct from ${sr.id}::text))
        order by ${sr.dueAt}
        limit 1
        for update of sr skip locked
      )
      update ${sequenceStepRuns} u set status = 'drafting', attempt_count = ${u.attemptCount} + 1, claim_token = ${NEW_CLAIM_TOKEN}, updated_at = ${ts(now)}
      from pick where ${u.id} = pick.id and ${u.status} in ${sqlValues(CLAIMABLE)}
      returning ${u.id}, ${u.organizationId}, ${u.attemptCount}, ${u.claimToken}`),
  );
  return claimed ?? null;
}

export const drizzleSequenceEngine: SequenceEngineStore = {
  // Only new replies start a run: the reply arrived no earlier than NEW_REPLY_MARGIN_MINUTES before the flow was turned
  // on, the rules the applied pick stored keep follow-ups going (`startFollowUpsSql`, the rule `startBlockedReason`
  // reads), and the reply did not ask to stop.
  // A run that skips step 1 (a person answered, or the type is set to Don't write a reply draft) needs a step 2.
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
          and ${startFollowUpsSql("r", "s")} = 'continue'
          and not ${stopRequestedSql(sql`r.latest_inbound_message_id`)}
          and p.email is not null
          and p.lifecycle <> 'contact'
          and exists (select 1 from reply_type_picks cl where cl.message_id = r.latest_inbound_message_id and cl.expected_context_version = r.context_version and cl.status in ('auto_applied', 'accepted', 'overridden'))
          and not exists (select 1 from sequence_runs sr where sr.record_id = r.id and (sr.trigger_message_id = r.latest_inbound_message_id or sr.status in ('active', 'paused')))
          and not ${doNotContactSql("p")}
          and not ${suppressedSql("p")}
          and (not ((r.last_outbound_at is not null and r.last_inbound_at is not null and r.last_outbound_at >= r.last_inbound_at) or not ${startReplyDraftSql("r", "s")})
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
    const rows = await db
      .select({ id: sequenceStepRuns.id, organizationId: sequenceStepRuns.organizationId, runId: sequenceStepRuns.sequenceRunId })
      .from(sequenceStepRuns)
      .innerJoin(sequenceRuns, and(eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId), eq(sequenceRuns.status, "active")))
      .innerJoin(drafts, eq(drafts.id, sequenceStepRuns.draftId))
      .where(and(eq(sequenceStepRuns.status, "awaiting_review"), inArray(drafts.status, ["sent", "discarded", "stale", "failed"])))
      .orderBy(asc(sequenceStepRuns.updatedAt))
      .limit(limit);
    let settled = 0;
    let deferred = 0;
    for (const row of rows) {
      // A next step that moved under the advance rolls the settle back; the row waits for the next tick.
      const did = await db.transaction(async (tx) => {
        const ofRun = and(eq(sequenceRuns.id, row.runId), eq(sequenceRuns.organizationId, row.organizationId));
        // Lock order is record, run, step run, as in `endRunTx`. A stop that committed first leaves nothing to settle.
        const [owner] = await tx.select({ recordId: sequenceRuns.recordId }).from(sequenceRuns).where(ofRun);
        if (!owner) return false;
        await lockRecordTx(tx, row.organizationId, owner.recordId);
        const [live] = await tx.select({ status: sequenceRuns.status }).from(sequenceRuns).where(ofRun).for("update");
        if (!live || live.status !== "active") return false;
        const [sr] = await tx
          .select({
            id: sequenceStepRuns.id,
            runId: sequenceStepRuns.sequenceRunId,
            recordId: sequenceRuns.recordId,
            position: sequenceSteps.position,
            attemptCount: sequenceStepRuns.attemptCount,
            draftId: drafts.id,
            draftStatus: drafts.status,
            draftError: drafts.error,
          })
          .from(sequenceStepRuns)
          .innerJoin(sequenceRuns, and(eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId), eq(sequenceRuns.status, "active")))
          .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceStepRuns.sequenceStepId))
          .innerJoin(drafts, eq(drafts.id, sequenceStepRuns.draftId))
          .where(and(eq(sequenceStepRuns.id, row.id), eq(sequenceStepRuns.organizationId, row.organizationId), eq(sequenceStepRuns.status, "awaiting_review")))
          .for("update", { of: sequenceStepRuns, skipLocked: true });
        if (!sr) return false;
        const ofStep = eq(sequenceStepRuns.id, sr.id);
        if (sr.draftStatus === "sent") {
          const [sent] = await tx
            .select({ id: messages.id, sentAt: messages.sentAt })
            .from(messages)
            .where(and(eq(messages.organizationId, row.organizationId), eq(messages.direction, "outbound"), sql`${messages.raw}->>'draftId' = ${sr.draftId}`))
            .orderBy(asc(messages.sentAt))
            .limit(1);
          if (!sent) return false;
          await tx.update(sequenceStepRuns).set({ status: "sent", sentMessageId: sent.id, lastError: null, updatedAt: now }).where(and(ofStep, stepMayBecome("sent")));
          await advanceRunTx(tx, { organizationId: row.organizationId, runId: sr.runId, afterPosition: sr.position, from: sent.sentAt, now });
          await recordEvent(tx, { organizationId: row.organizationId, recordId: sr.recordId, type: "sequence.step_sent", actorUserId: null, to: { sequenceRunId: sr.runId, position: sr.position, messageId: sent.id } });
        } else if (sr.draftStatus === "discarded") {
          // A person discarded the draft: that step is handled, and the next waits its own delay from now.
          await tx.update(sequenceStepRuns).set({ status: "skipped", updatedAt: now }).where(and(ofStep, stepMayBecome("skipped")));
          await advanceRunTx(tx, { organizationId: row.organizationId, runId: sr.runId, afterPosition: sr.position, from: now, now });
          await recordEvent(tx, { organizationId: row.organizationId, recordId: sr.recordId, type: "sequence.step_skipped", actorUserId: null, to: { sequenceRunId: sr.runId, position: sr.position, reason: "draft_discarded" } });
        } else if (sr.draftStatus === "stale") {
          // Superseded or outdated by a context change that did not stop the run: draft the step again, a few times.
          if (sr.attemptCount >= MAX_DRAFT_ATTEMPTS) {
            await tx.update(sequenceStepRuns).set({ status: "failed", lastError: "The draft kept going stale.", updatedAt: now }).where(and(ofStep, stepMayBecome("failed")));
          } else {
            await tx.update(sequenceStepRuns).set({ status: "scheduled", draftId: null, dueAt: now, updatedAt: now }).where(and(ofStep, stepMayBecome("scheduled")));
          }
        } else {
          await tx.update(sequenceStepRuns).set({ status: "failed", lastError: sr.draftError ?? "The draft failed.", updatedAt: now }).where(and(ofStep, stepMayBecome("failed")));
        }
        return true;
      }).catch((error: unknown) => {
        if (!(error instanceof StepMovedError)) throw error;
        deferred += 1;
        return false;
      });
      if (did) settled += 1;
    }
    return { settled, deferred };
  },

  async claimDue(workerId, now, leaseMs) {
    const expired = new Date(now.getTime() - leaseMs);
    // A step whose drafting died too many times stops retrying. The sweep covers every organization, as the claim
    // below does, and touches only steps whose lease ran out. A worker still on its last attempt changes nothing after
    // it: its settles no longer find the step drafting.
    await db
      .update(sequenceStepRuns)
      .set({ status: "failed", lastError: "Drafting did not finish.", claimToken: null, updatedAt: now })
      .where(and(eq(sequenceStepRuns.status, "drafting"), lt(sequenceStepRuns.updatedAt, expired), gte(sequenceStepRuns.attemptCount, MAX_DRAFT_ATTEMPTS)));
    const claimed = await takeDueStep(now, expired);
    if (!claimed) return null;
    void workerId;
    const [[d], timeZone] = await Promise.all([
      db
        .select({ run: sequenceRuns, step: sequenceSteps })
        .from(sequenceStepRuns)
        .innerJoin(sequenceRuns, eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId))
        .innerJoin(sequenceSteps, eq(sequenceSteps.id, sequenceStepRuns.sequenceStepId))
        .where(eq(sequenceStepRuns.id, claimed.id)),
      organizationTimeZone(claimed.organization_id),
    ]);
    return {
      stepRunId: claimed.id,
      organizationId: claimed.organization_id,
      claimToken: claimed.claim_token,
      attempts: claimed.attempt_count,
      run: { id: d.run.id, recordId: d.run.recordId, conversationId: d.run.conversationId, sequenceVersionId: d.run.sequenceVersionId, triggerMessageId: d.run.triggerMessageId },
      step: {
        id: d.step.id,
        sequenceVersionId: d.step.sequenceVersionId,
        position: d.step.position,
        stepType: stepTypeAt(d.step.position),
        name: d.step.name,
        delayMinutes: d.step.delayMinutes,
        subjectTemplate: d.step.subjectTemplate,
        bodyTemplate: d.step.bodyTemplate,
        aiInstructions: d.step.aiInstructions,
        knowledgeTags: d.step.knowledgeTags ?? [],
      },
      timeZone,
    };
  },

  async release(claim, dueAt, now) {
    await db
      .update(sequenceStepRuns)
      .set({ status: "scheduled", dueAt, attemptCount: sql`greatest(${sequenceStepRuns.attemptCount} - 1, 0)`, claimToken: null, updatedAt: now })
      .where(heldStep(claim));
  },

  async failAttempt(claim, error, retryAt, now) {
    if (retryAt) {
      await db.update(sequenceStepRuns).set({ status: "scheduled", dueAt: retryAt, lastError: error, claimToken: null, updatedAt: now }).where(heldStep(claim));
    } else {
      await db.update(sequenceStepRuns).set({ status: "failed", lastError: error, claimToken: null, updatedAt: now }).where(heldStep(claim));
    }
  },

  async openDrafts(organizationId, recordId) {
    return db
      .select({ id: drafts.id, status: drafts.status, replyForMessageId: drafts.replyForMessageId })
      .from(drafts)
      .where(and(eq(drafts.organizationId, organizationId), eq(drafts.recordId, recordId), inArray(drafts.status, [...PENDING_DRAFT_STATUSES]), unlinked(db)));
  },

  async orphanDraft(organizationId, stepRunId) {
    const [row] = await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.organizationId, organizationId), writtenFor(stepRunId), inArray(drafts.status, [...UNSENT_DRAFT_STATUSES]), unlinked(db)))
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    return row?.id ?? null;
  },

  async writeDraft(claim, draft) {
    // `insertDraftTx` locks the record first and then the step row, the order `linkDraft` and `endRunTx` take them in.
    // The row lock makes a takeover skip the step until the draft is in, so the new holder adopts it as an orphan.
    let late: LateOutcome = "lost";
    const written = await db.transaction((tx) =>
      insertDraftTx(tx, draft, async (locked) => {
        const [row] = await locked
          .select({ runStatus: sequenceRuns.status, held: sql<boolean>`${heldStep(claim)}` })
          .from(sequenceStepRuns)
          .innerJoin(sequenceRuns, eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId))
          .where(and(eq(sequenceStepRuns.id, claim.stepRunId), eq(sequenceStepRuns.organizationId, claim.organizationId)))
          .for("update", { of: sequenceStepRuns });
        if (!row || !LIVE_RUN.includes(row.runStatus)) late = "stopped";
        return row?.held === true && row.runStatus === "active";
      }),
    );
    return written ?? late;
  },

  async linkDraft(claim, draftId, now) {
    const { organizationId, stepRunId } = claim;
    const ofStep = and(eq(sequenceStepRuns.id, stepRunId), eq(sequenceStepRuns.organizationId, organizationId));
    return db.transaction(async (tx: Tx): Promise<LinkOutcome> => {
      // Lock order is record, run, step run, as in `endRunTx`, so a stop, a pause and this link serialize.
      const [peek] = await tx
        .select({ recordId: sequenceRuns.recordId })
        .from(sequenceStepRuns)
        .innerJoin(sequenceRuns, eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId))
        .where(ofStep);
      if (!peek) return "stopped";
      await lockRecordTx(tx, organizationId, peek.recordId);
      const [sr] = await tx
        .select({ recordId: sequenceRuns.recordId, runStatus: sequenceRuns.status })
        .from(sequenceStepRuns)
        .innerJoin(sequenceRuns, eq(sequenceRuns.id, sequenceStepRuns.sequenceRunId))
        .where(ofStep)
        .for("update", { of: sequenceRuns });
      if (!sr) return "stopped";
      const [step] = await tx
        .select({ status: sequenceStepRuns.status, held: sql<boolean>`${heldBy("sequence_step_runs", claim, "attempt_count")}` })
        .from(sequenceStepRuns)
        .where(eq(sequenceStepRuns.id, stepRunId))
        .for("update");
      // A pause gives the step back without ending the run, so it answers `lost`. Only an ended run is `stopped`.
      const late: LinkOutcome | null = !LIVE_RUN.includes(sr.runStatus) ? "stopped" : sr.runStatus !== "active" || step.status !== "drafting" || !step.held ? "lost" : null;
      if (late) {
        // A claim that still drafts the step adopts this draft as its orphan.
        if (late === "stopped" || step.status !== "drafting") {
          await retireStepDraft(tx, claim, draftId, late === "stopped" ? "The follow-up sequence ended." : "The follow-up step moved on without this draft.", now);
        }
        return late;
      }
      // The draft must belong to the run's record. SQL only knows both sit in the organization.
      const [draft] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId), eq(drafts.recordId, sr.recordId)));
      if (!draft) throw new Error("The draft does not belong to the run's record.");
      await tx
        .update(sequenceStepRuns)
        .set({ status: "awaiting_review", draftId, lastError: null, claimToken: null, updatedAt: now })
        .where(and(heldStep(claim), stepMayBecome("awaiting_review")));
      await tx.execute(sql`
        update records set workflow_state = 'action_required', next_action_at = null
        where id = ${sr.recordId} and organization_id = ${organizationId} and workflow_state in ('waiting', 'idle')`);
      await recordEvent(tx, { organizationId, recordId: sr.recordId, type: "sequence.draft_created", actorUserId: null, to: { stepRunId, draftId } });
      return "linked";
    });
  },

  async knowledgeForTags(organizationId, tags) {
    return knowledgeFor(organizationId, { alwaysOnly: false, stepTags: tags, includeUnmatched: false });
  },
};
