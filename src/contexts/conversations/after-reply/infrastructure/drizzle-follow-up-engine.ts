import { APPLIED_PICK_STATUSES } from "../../domain/reply-type-pick";
import { and, asc, desc, eq, inArray, lt, gte, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/platform/db/client";
import { campaigns, drafts, messages, conversations } from "@/platform/db/schema";
import type { ClaimedStep, InterruptCandidate, LateOutcome, LinkOutcome, FollowUpEngineStore } from "../application/follow-up-ports";
import { ACTIVE_RUN_STATUSES, MAX_DRAFT_ATTEMPTS, STEP_FROM, stepTypeAt, type InterruptFacts, type StepRunStatus } from "../domain/follow-ups";
import { NEW_REPLY_MARGIN_MINUTES } from "../domain/after-reply";
import type { FollowUpsRule } from "../../domain/reply-type";
import { flowRunnableSql, owningCampaignSql, startableCampaignSql, startFollowUpsSql, startReplyDraftSql } from "./after-reply-sql";
import { rowsOf } from "@/platform/db/sql-values";
import { heldBy, NEW_CLAIM_TOKEN } from "@/platform/db/claim";
import { advanceRunTx, StepMovedError, ts } from "./follow-up-run-tx";
import { endRunTx, lockConversationTx, recordEvent, stepMayBecome, type Tx } from "./follow-up-stop";
import { followUpRuns, followUpFlows, followUpSteps, followUpStepRuns } from "./follow-ups-schema";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { knowledgeFor } from "../../infrastructure/thread-context";
import { insertDraftTx } from "../../infrastructure/reply-store-drafts";
import { stopRequestedSql } from "../../stopping/infrastructure/stop-requested-sql";
import { PENDING_DRAFT_STATUSES, RETIRABLE_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES } from "../../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";
import { doNotContactSql, suppressedSql } from "@/contexts/people/infrastructure/reachability";

const PENDING_DRAFTS = sqlValues(PENDING_DRAFT_STATUSES);
/** Run statuses that have not ended. A paused run gives its steps back; an ended one stops them. */
const LIVE_RUN: readonly string[] = ACTIVE_RUN_STATUSES;

/** The fence of a step run settle: the step is still drafting under this claim. */
const heldStep = (claim: ClaimedStep) =>
  and(
    eq(followUpStepRuns.id, claim.stepRunId),
    eq(followUpStepRuns.organizationId, claim.organizationId),
    eq(followUpStepRuns.status, "drafting"),
    heldBy("follow_up_step_runs", claim, "attempt_count"),
  );

/** The draft no step run links yet. */
const unlinked = (tx: Tx | typeof db) => notExists(tx.select({ one: sql`1` }).from(followUpStepRuns).where(eq(followUpStepRuns.draftId, drafts.id)));
/** The draft a worker wrote for this step run, found by its request. */
const writtenFor = (stepRunId: string) => sql`${drafts.request}->>'followUpStepRunId' = ${stepRunId}`;

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
  conversation_id: string;
  trigger_message_id: string;
  run_reply_type_id: string;
  run_channel: string;
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
  conversationId: r.conversation_id,
  facts: {
    run: { triggerMessageId: r.trigger_message_id, replyTypeId: r.run_reply_type_id, channel: r.run_channel },
    conversation: { latestInboundMessageId: r.latest_inbound_message_id, replyTypeId: r.reply_type_id, groupKey: r.group_key, replyTypeKey: r.sub_key, followUps: r.follow_ups, workflowState: r.workflow_state },
    doNotContact: r.dnc,
    suppression: r.suppression,
    contact: r.contact,
    flowActive: r.flow_active,
  },
});

/** The facts that decide whether a run must stop, for the runs matching `where`. Every join stays inside the run's organization. */
const factsQuery = (where: SQL, tail: SQL = sql``) => sql`
  select r.id as run_id, r.organization_id, r.conversation_id, r.trigger_message_id, r.reply_type_id as run_reply_type_id, t.channel as run_channel,
         rec.latest_inbound_message_id, rec.reply_type_id, rec.group_key, s.key as sub_key, s.follow_ups, rec.workflow_state,
         ${doNotContactSql("p")} as dnc,
         (select sl.reason from suppression_list sl where sl.organization_id = r.organization_id and sl.email = lower(p.email)
           order by case sl.reason when 'unsubscribed' then 0 when 'bounced' then 1 else 2 end limit 1) as suppression,
         p.lifecycle = 'contact' as contact,
         ${flowRunnableSql("fl")} as flow_active
  from follow_up_runs r
  join follow_up_flows fl on fl.id = r.flow_id and fl.organization_id = r.organization_id
  join conversations rec on rec.id = r.conversation_id and rec.organization_id = r.organization_id
  join people p on p.id = rec.person_id and p.organization_id = r.organization_id
  join threads t on t.id = r.thread_id and t.organization_id = r.organization_id
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
  const sr = alias(followUpStepRuns, "sr");
  const r = alias(followUpRuns, "r");
  const st = alias(followUpSteps, "st");
  const rec = alias(conversations, "rec");
  const fl = alias(followUpFlows, "fl");
  const camp = alias(campaigns, "camp");
  const d = alias(drafts, "d");
  const u = alias(followUpStepRuns, "u");
  const [claimed] = rowsOf<{ id: string; organization_id: string; attempt_count: number; claim_token: string }>(
    await db.execute(sql`
      with pick as (
        select ${sr.id}
        from ${followUpStepRuns} sr
        join ${followUpRuns} r on ${r.id} = ${sr.followUpRunId} and ${r.organizationId} = ${sr.organizationId}
        join ${followUpSteps} st on ${st.id} = ${sr.followUpStepId}
        join ${conversations} rec on ${rec.id} = ${r.conversationId}
        join ${followUpFlows} fl on ${fl.id} = ${r.flowId} and ${fl.organizationId} = ${r.organizationId}
        left join ${campaigns} camp on ${camp.id} = ${fl.campaignId} and ${camp.organizationId} = ${fl.organizationId}
        where ${r.status} = 'active' ${organizationId ? sql`and ${sr.organizationId} = ${organizationId}` : sql``}
          and ${flowRunnableSql("fl")}
          and (${camp.id} is null or ${camp.status} <> 'paused')
          and ${st.position} = ${r.currentStepPosition}
          and ${rec.workflowState} <> 'closed'
          -- A step drafting past its lease with every attempt used is never taken over: the sweep in claimDue fails it.
          and ((${sr.status} = 'scheduled' and ${sr.dueAt} <= ${ts(now)})
               or (${sr.status} = 'drafting' and ${sr.updatedAt} < ${ts(expired)} and ${sr.attemptCount} < ${MAX_DRAFT_ATTEMPTS}))
          and (${st.position} = 1 or not exists (
                select 1 from ${drafts} d
                where ${d.conversationId} = ${rec.id} and ${d.status} in ${PENDING_DRAFTS} and ${d.request}->>'followUpStepRunId' is distinct from ${sr.id}::text))
        order by ${sr.dueAt}
        limit 1
        for update of sr skip locked
      )
      update ${followUpStepRuns} u set status = 'drafting', attempt_count = ${u.attemptCount} + 1, claim_token = ${NEW_CLAIM_TOKEN}, updated_at = ${ts(now)}
      from pick where ${u.id} = pick.id and ${u.status} in ${sqlValues(CLAIMABLE)}
      returning ${u.id}, ${u.organizationId}, ${u.attemptCount}, ${u.claimToken}`),
  );
  return claimed ?? null;
}

export const drizzleFollowUpEngine: FollowUpEngineStore = {
  // Only new replies start a run: the reply arrived no earlier than NEW_REPLY_MARGIN_MINUTES before the flow was turned
  // on, the rules the applied pick stored keep follow-ups going (`startFollowUpsSql`, the rule `startBlockedReason`
  // reads), and the reply did not ask to stop.
  // A run that skips step 1 (a person answered, or the type is set to Don't write a reply draft) needs a step 2.
  async startCandidates(limit) {
    return rowsOf<{ organization_id: string; id: string }>(
      await db.execute(sql`
        select r.organization_id, r.id
        from conversations r
        join reply_types s on s.id = r.reply_type_id
        join people p on p.id = r.person_id
        join messages lm on lm.id = r.latest_inbound_message_id
        join threads c on c.id = lm.thread_id and c.channel = 'email'
        join lateral (${owningCampaignSql({ organizationId: sql`r.organization_id`, personId: sql`r.person_id`, at: sql`lm.sent_at` })}) own on true
        join lateral (
          select sq.id as flow_id, v.id as version_id, sq.after_reply_enabled_at as enabled_at
          from follow_up_flows sq join follow_up_versions v on v.flow_id = sq.id and v.status = 'published'
          where sq.campaign_id = own.id and sq.status = 'active'
          order by v.version desc limit 1
        ) pick on true
        where r.latest_inbound_message_id is not null
          and ${startableCampaignSql({ channel: sql`own.channel`, status: sql`own.status`, archivedAt: sql`own.archived_at` })}
          and lm.sent_at >= pick.enabled_at - make_interval(mins => ${NEW_REPLY_MARGIN_MINUTES})
          and r.workflow_state <> 'closed'
          and ${startFollowUpsSql("r", "s")} = 'continue'
          and not ${stopRequestedSql(sql`r.latest_inbound_message_id`)}
          and p.email is not null
          and p.lifecycle <> 'contact'
          and exists (select 1 from reply_type_picks cl where cl.message_id = r.latest_inbound_message_id and cl.expected_context_version = r.context_version and cl.status in ${sqlValues(APPLIED_PICK_STATUSES)})
          and not exists (select 1 from follow_up_runs sr where sr.conversation_id = r.id and (sr.trigger_message_id = r.latest_inbound_message_id or sr.status in ('active', 'paused')))
          and not ${doNotContactSql("p")}
          and not ${suppressedSql("p")}
          and (not ((r.last_outbound_at is not null and r.last_inbound_at is not null and r.last_outbound_at >= r.last_inbound_at) or not ${startReplyDraftSql("r", "s")})
               or (select count(*) from follow_up_steps st where st.follow_up_version_id = pick.version_id) >= 2)
        order by r.last_inbound_at desc nulls last
        limit ${limit}`),
    ).map((r) => ({ organizationId: r.organization_id, conversationId: r.id }));
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
      .select({ id: followUpStepRuns.id, organizationId: followUpStepRuns.organizationId, runId: followUpStepRuns.followUpRunId })
      .from(followUpStepRuns)
      .innerJoin(followUpRuns, and(eq(followUpRuns.id, followUpStepRuns.followUpRunId), eq(followUpRuns.status, "active")))
      .innerJoin(drafts, eq(drafts.id, followUpStepRuns.draftId))
      .where(and(eq(followUpStepRuns.status, "awaiting_review"), inArray(drafts.status, ["sent", "discarded", "stale", "failed"])))
      .orderBy(asc(followUpStepRuns.updatedAt))
      .limit(limit);
    let settled = 0;
    let deferred = 0;
    for (const row of rows) {
      // A next step that moved under the advance rolls the settle back; the row waits for the next tick.
      const did = await db.transaction(async (tx) => {
        const ofRun = and(eq(followUpRuns.id, row.runId), eq(followUpRuns.organizationId, row.organizationId));
        // Lock order is conversation, run, step run, as in `endRunTx`. A stop that committed first leaves nothing to settle.
        const [owner] = await tx.select({ conversationId: followUpRuns.conversationId }).from(followUpRuns).where(ofRun);
        if (!owner) return false;
        await lockConversationTx(tx, row.organizationId, owner.conversationId);
        const [live] = await tx.select({ status: followUpRuns.status }).from(followUpRuns).where(ofRun).for("update");
        if (!live || live.status !== "active") return false;
        const [sr] = await tx
          .select({
            id: followUpStepRuns.id,
            runId: followUpStepRuns.followUpRunId,
            conversationId: followUpRuns.conversationId,
            position: followUpSteps.position,
            attemptCount: followUpStepRuns.attemptCount,
            draftId: drafts.id,
            draftStatus: drafts.status,
            draftError: drafts.error,
          })
          .from(followUpStepRuns)
          .innerJoin(followUpRuns, and(eq(followUpRuns.id, followUpStepRuns.followUpRunId), eq(followUpRuns.status, "active")))
          .innerJoin(followUpSteps, eq(followUpSteps.id, followUpStepRuns.followUpStepId))
          .innerJoin(drafts, eq(drafts.id, followUpStepRuns.draftId))
          .where(and(eq(followUpStepRuns.id, row.id), eq(followUpStepRuns.organizationId, row.organizationId), eq(followUpStepRuns.status, "awaiting_review")))
          .for("update", { of: followUpStepRuns, skipLocked: true });
        if (!sr) return false;
        const ofStep = eq(followUpStepRuns.id, sr.id);
        if (sr.draftStatus === "sent") {
          const [sent] = await tx
            .select({ id: messages.id, sentAt: messages.sentAt })
            .from(messages)
            .where(and(eq(messages.organizationId, row.organizationId), eq(messages.direction, "outbound"), sql`${messages.raw}->>'draftId' = ${sr.draftId}`))
            .orderBy(asc(messages.sentAt))
            .limit(1);
          if (!sent) return false;
          await tx.update(followUpStepRuns).set({ status: "sent", sentMessageId: sent.id, lastError: null, updatedAt: now }).where(and(ofStep, stepMayBecome("sent")));
          await advanceRunTx(tx, { organizationId: row.organizationId, runId: sr.runId, afterPosition: sr.position, from: sent.sentAt, now });
          await recordEvent(tx, { organizationId: row.organizationId, conversationId: sr.conversationId, type: "follow_up.step_sent", actorUserId: null, to: { followUpRunId: sr.runId, position: sr.position, messageId: sent.id } });
        } else if (sr.draftStatus === "discarded") {
          // A person discarded the draft: that step is handled, and the next waits its own delay from now.
          await tx.update(followUpStepRuns).set({ status: "skipped", updatedAt: now }).where(and(ofStep, stepMayBecome("skipped")));
          await advanceRunTx(tx, { organizationId: row.organizationId, runId: sr.runId, afterPosition: sr.position, from: now, now });
          await recordEvent(tx, { organizationId: row.organizationId, conversationId: sr.conversationId, type: "follow_up.step_skipped", actorUserId: null, to: { followUpRunId: sr.runId, position: sr.position, reason: "draft_discarded" } });
        } else if (sr.draftStatus === "stale") {
          // Superseded or outdated by a context change that did not stop the run: draft the step again, a few times.
          if (sr.attemptCount >= MAX_DRAFT_ATTEMPTS) {
            await tx.update(followUpStepRuns).set({ status: "failed", lastError: "The draft kept going stale.", updatedAt: now }).where(and(ofStep, stepMayBecome("failed")));
          } else {
            await tx.update(followUpStepRuns).set({ status: "scheduled", draftId: null, dueAt: now, updatedAt: now }).where(and(ofStep, stepMayBecome("scheduled")));
          }
        } else {
          await tx.update(followUpStepRuns).set({ status: "failed", lastError: sr.draftError ?? "The draft failed.", updatedAt: now }).where(and(ofStep, stepMayBecome("failed")));
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
      .update(followUpStepRuns)
      .set({ status: "failed", lastError: "Drafting did not finish.", claimToken: null, updatedAt: now })
      .where(and(eq(followUpStepRuns.status, "drafting"), lt(followUpStepRuns.updatedAt, expired), gte(followUpStepRuns.attemptCount, MAX_DRAFT_ATTEMPTS)));
    const claimed = await takeDueStep(now, expired);
    if (!claimed) return null;
    void workerId;
    const [[d], timeZone] = await Promise.all([
      db
        .select({ run: followUpRuns, step: followUpSteps })
        .from(followUpStepRuns)
        .innerJoin(followUpRuns, eq(followUpRuns.id, followUpStepRuns.followUpRunId))
        .innerJoin(followUpSteps, eq(followUpSteps.id, followUpStepRuns.followUpStepId))
        .where(eq(followUpStepRuns.id, claimed.id)),
      organizationTimeZone(claimed.organization_id),
    ]);
    return {
      stepRunId: claimed.id,
      organizationId: claimed.organization_id,
      claimToken: claimed.claim_token,
      attempts: claimed.attempt_count,
      run: { id: d.run.id, conversationId: d.run.conversationId, threadId: d.run.threadId, followUpVersionId: d.run.followUpVersionId, triggerMessageId: d.run.triggerMessageId },
      step: {
        id: d.step.id,
        followUpVersionId: d.step.followUpVersionId,
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
      .update(followUpStepRuns)
      .set({ status: "scheduled", dueAt, attemptCount: sql`greatest(${followUpStepRuns.attemptCount} - 1, 0)`, claimToken: null, updatedAt: now })
      .where(heldStep(claim));
  },

  async failAttempt(claim, error, retryAt, now) {
    if (retryAt) {
      await db.update(followUpStepRuns).set({ status: "scheduled", dueAt: retryAt, lastError: error, claimToken: null, updatedAt: now }).where(heldStep(claim));
    } else {
      await db.update(followUpStepRuns).set({ status: "failed", lastError: error, claimToken: null, updatedAt: now }).where(heldStep(claim));
    }
  },

  async openDrafts(organizationId, conversationId) {
    return db
      .select({ id: drafts.id, status: drafts.status, replyForMessageId: drafts.replyForMessageId })
      .from(drafts)
      .where(and(eq(drafts.organizationId, organizationId), eq(drafts.conversationId, conversationId), inArray(drafts.status, [...PENDING_DRAFT_STATUSES]), unlinked(db)));
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
    // `insertDraftTx` locks the conversation first and then the step row, the order `linkDraft` and `endRunTx` take them in.
    // The row lock makes a takeover skip the step until the draft is in, so the new holder adopts it as an orphan.
    let late: LateOutcome = "lost";
    const written = await db.transaction((tx) =>
      insertDraftTx(tx, draft, async (locked) => {
        const [row] = await locked
          .select({ runStatus: followUpRuns.status, held: sql<boolean>`${heldStep(claim)}` })
          .from(followUpStepRuns)
          .innerJoin(followUpRuns, eq(followUpRuns.id, followUpStepRuns.followUpRunId))
          .where(and(eq(followUpStepRuns.id, claim.stepRunId), eq(followUpStepRuns.organizationId, claim.organizationId)))
          .for("update", { of: followUpStepRuns });
        if (!row || !LIVE_RUN.includes(row.runStatus)) late = "stopped";
        return row?.held === true && row.runStatus === "active";
      }),
    );
    return written === "handling_closed" ? "stopped" : (written ?? late);
  },

  async linkDraft(claim, draftId, now) {
    const { organizationId, stepRunId } = claim;
    const ofStep = and(eq(followUpStepRuns.id, stepRunId), eq(followUpStepRuns.organizationId, organizationId));
    return db.transaction(async (tx: Tx): Promise<LinkOutcome> => {
      // Lock order is conversation, run, step run, as in `endRunTx`, so a stop, a pause and this link serialize.
      const [peek] = await tx
        .select({ conversationId: followUpRuns.conversationId })
        .from(followUpStepRuns)
        .innerJoin(followUpRuns, eq(followUpRuns.id, followUpStepRuns.followUpRunId))
        .where(ofStep);
      if (!peek) return "stopped";
      await lockConversationTx(tx, organizationId, peek.conversationId);
      const [sr] = await tx
        .select({ conversationId: followUpRuns.conversationId, runStatus: followUpRuns.status })
        .from(followUpStepRuns)
        .innerJoin(followUpRuns, eq(followUpRuns.id, followUpStepRuns.followUpRunId))
        .where(ofStep)
        .for("update", { of: followUpRuns });
      if (!sr) return "stopped";
      const [step] = await tx
        .select({ status: followUpStepRuns.status, held: sql<boolean>`${heldBy("follow_up_step_runs", claim, "attempt_count")}` })
        .from(followUpStepRuns)
        .where(eq(followUpStepRuns.id, stepRunId))
        .for("update");
      // A pause gives the step back without ending the run, so it answers `lost`. Only an ended run is `stopped`.
      const late: LinkOutcome | null = !LIVE_RUN.includes(sr.runStatus) ? "stopped" : sr.runStatus !== "active" || step.status !== "drafting" || !step.held ? "lost" : null;
      if (late) {
        // A claim that still drafts the step adopts this draft as its orphan.
        if (late === "stopped" || step.status !== "drafting") {
          await retireStepDraft(tx, claim, draftId, late === "stopped" ? "The follow-ups ended." : "The follow-up step moved on without this draft.", now);
        }
        return late;
      }
      // The draft must belong to the run's conversation. SQL only knows both sit in the organization.
      const [draft] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.organizationId, organizationId), eq(drafts.conversationId, sr.conversationId)));
      if (!draft) throw new Error("The draft does not belong to the run's conversation.");
      await tx
        .update(followUpStepRuns)
        .set({ status: "awaiting_review", draftId, lastError: null, claimToken: null, updatedAt: now })
        .where(and(heldStep(claim), stepMayBecome("awaiting_review")));
      await tx.execute(sql`
        update conversations set workflow_state = 'action_required', next_action_at = null
        where id = ${sr.conversationId} and organization_id = ${organizationId} and workflow_state in ('waiting', 'idle')`);
      await recordEvent(tx, { organizationId, conversationId: sr.conversationId, type: "follow_up.draft_created", actorUserId: null, to: { stepRunId, draftId } });
      return "linked";
    });
  },

  async knowledgeForTags(organizationId, tags) {
    return knowledgeFor(organizationId, { alwaysOnly: false, stepTags: tags, includeUnmatched: false });
  },
};
