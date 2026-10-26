import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { runStatusLabel, startBlockedReason, startedByLabel, stopReasonLabel } from "../domain/after-reply";
import { assertConversationBelongsToRecord, assertStepsBelongToVersion, isAnswered, planDueDates, startPosition } from "../domain/sequences";
import { needsReply } from "../../domain/reply-policy";
import type { RecordSequenceState, RunSource, RunStore, StartFacts } from "./sequence-ports";

/**
 * Use cases for the follow-ups of one record. The flow itself belongs to a campaign (see after-reply.ts); a run
 * pins the newest published version of the flow of the campaign that most recently emailed the person.
 * Nothing here sends: a run only schedules steps, and the job turns a due step into a draft a person approves.
 */

export interface SequenceDeps {
  runs: RunStore;
  now: () => Date;
}

// Starting runs ---------------------------------------------------------------------------------------

export interface StartRunInput {
  organizationId: string;
  recordId: string;
  /** Defaults to the conversation holding the record's latest inbound message. */
  conversationId?: string;
  source: RunSource;
  actorUserId?: string | null;
  /** Skip the reply step: a person already answered. */
  skipReply?: boolean;
  /** Replace a run in progress even when it matches the one that would start. */
  restart?: boolean;
}

/** The first reason no run can start from these facts, or null. The same words reach the Restart button and the 409. */
export function startBlocker(facts: StartFacts, input: { source: RunSource; skipReply?: boolean }): string | null {
  const { record } = facts;
  const blocked = startBlockedReason({
    record,
    conversation: facts.conversation,
    doNotContact: facts.doNotContact,
    suppressed: facts.suppressed,
    contact: facts.contact,
    owner: facts.owner,
    flow: facts.flow,
    stepCount: facts.steps.length,
    answered: isAnswered(record),
    skipReply: input.skipReply,
  });
  if (blocked) return blocked;
  if (input.source === "ai_assignment" && (!record.groupKey || !record.replyTypeKey || !needsReply(record.groupKey, record.replyTypeKey))) {
    return `The reply is classified as ${record.replyTypeName ?? "this category"}, which needs no answer, so follow-ups do not apply.`;
  }
  // The owner passed every check but the store found no flow to run: a campaign or flow changed between the reads.
  return facts.selection ? null : "Follow-ups cannot start for this conversation right now.";
}

export type StartOutcome = { started: { runId: string; created: boolean } } | { blocked: string };

/**
 * Starts a run pinned to the newest published version of the owning campaign's flow, or answers why none can start
 * (no flow, the campaign is paused or in handoff mode, no reply wanted, a terminal subcategory). Proves the two facts
 * SQL cannot: the conversation belongs to the record, and every step belongs to the pinned version. A run already
 * started for the same message and version is returned as is.
 */
export async function attemptRun(deps: { runs: Pick<RunStore, "loadStart" | "createRun">; now: () => Date }, input: StartRunInput): Promise<StartOutcome> {
  const facts = await deps.runs.loadStart(input.organizationId, input.recordId, { conversationId: input.conversationId });
  if (!facts) throw new NotFoundError("Reply handling not found");
  const { record } = facts;
  if (facts.conversation) assertConversationBelongsToRecord(facts.conversation, record.id);
  const blocked = startBlocker(facts, { source: input.source, skipReply: input.skipReply });
  if (blocked || !facts.selection || !facts.conversation || !record.replyTypeId || !record.latestInboundMessageId || !record.lastInboundAt) {
    return { blocked: blocked ?? "Follow-ups cannot start for this conversation right now." };
  }

  assertStepsBelongToVersion(facts.steps, facts.selection.sequenceVersionId);
  const from = startPosition({ stepCount: facts.steps.length, answered: isAnswered(record), skipReply: input.skipReply });
  if (from === null) return { blocked: "A person already answered, and the flow has no follow-up step after the reply." };

  const now = deps.now();
  const due = planDueDates(now, facts.steps, from, facts.timeZone);
  const started = await deps.runs.createRun({
    organizationId: input.organizationId,
    recordId: record.id,
    conversationId: facts.conversation.id,
    sequenceId: facts.selection.sequenceId,
    sequenceVersionId: facts.selection.sequenceVersionId,
    replyTypeId: record.replyTypeId,
    source: input.source,
    startPosition: from,
    triggerMessageId: record.latestInboundMessageId,
    lastInboundAtStart: record.lastInboundAt,
    contextVersion: record.contextVersion,
    steps: facts.steps.filter((s) => s.position >= from).map((s) => ({ stepId: s.id, position: s.position, dueAt: due.get(s.position) as Date })),
    actorUserId: input.actorUserId ?? null,
    restart: input.restart,
    now,
  });
  return { started };
}

/** Starts a run, or returns null when nothing applies. */
export async function startRun(deps: { runs: Pick<RunStore, "loadStart" | "createRun">; now: () => Date }, input: StartRunInput): Promise<{ runId: string; created: boolean } | null> {
  const outcome = await attemptRun(deps, input);
  return "started" in outcome ? outcome.started : null;
}

// Per-record controls ---------------------------------------------------------------------------------

export interface RecordAfterReply extends Omit<RecordSequenceState, "run"> {
  /** A person can restart the follow-ups now. */
  canRestart: boolean;
  /** Why Restart would fail, in plain words. Null when it can run. */
  restartBlockedReason: string | null;
  run:
    | (NonNullable<RecordSequenceState["run"]> & {
        statusLabel: string;
        startedByLabel: string;
        endedReasonLabel: string | null;
      })
    | null;
}

export async function getRecordSequence(deps: SequenceDeps, actor: Actor, recordId: string): Promise<RecordAfterReply> {
  // The two reads do not depend on each other, so they run together. A missing record fails the first and empties the second.
  const [state, facts] = await Promise.all([deps.runs.recordState(actor.organizationId, recordId), deps.runs.loadStart(actor.organizationId, recordId, {})]);
  if (!state) throw new NotFoundError("Reply handling not found");
  const { run } = state;
  const restartBlockedReason = facts ? startBlocker(facts, { source: "human_override" }) : "This conversation has no email reply to follow up on.";
  return {
    ...state,
    canRestart: restartBlockedReason === null,
    restartBlockedReason,
    run: run
      ? {
          ...run,
          statusLabel: runStatusLabel(run.status),
          startedByLabel: startedByLabel(run.startedBy),
          endedReasonLabel: run.endedReason ? stopReasonLabel(run.endedReason) : null,
        }
      : null,
  };
}

/**
 * A person restarts the follow-ups: a run starts now from the flow of the campaign that most recently emailed this
 * person, replacing the current one. A reply a person already sent by hand skips the reply step.
 */
export async function restartSequenceRun(deps: SequenceDeps, actor: Actor, recordId: string, input: { conversationId?: string } = {}) {
  const outcome = await attemptRun(deps, { organizationId: actor.organizationId, recordId, conversationId: input.conversationId, source: "human_override", actorUserId: actor.userId, restart: true });
  if ("blocked" in outcome) throw new ConflictError(outcome.blocked, { code: "restart_blocked" });
  return outcome.started;
}

const event = (actor: Actor, recordId: string) => ({ organizationId: actor.organizationId, recordId, actorUserId: actor.userId });

export const pauseSequenceRun = (deps: SequenceDeps, actor: Actor, recordId: string) => deps.runs.pause(event(actor, recordId), deps.now());

export async function resumeSequenceRun(deps: SequenceDeps, actor: Actor, recordId: string) {
  await deps.runs.resume(event(actor, recordId), deps.now(), await deps.runs.timeZone(actor.organizationId));
}

export const cancelSequenceRun = (deps: SequenceDeps, actor: Actor, recordId: string) => deps.runs.cancel(event(actor, recordId), "manual", deps.now());

export async function skipSequenceStep(deps: SequenceDeps, actor: Actor, recordId: string) {
  return deps.runs.skipStep(event(actor, recordId), deps.now(), await deps.runs.timeZone(actor.organizationId));
}
