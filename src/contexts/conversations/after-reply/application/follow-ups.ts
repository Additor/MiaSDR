import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { runStatusLabel, startBlockedReason, startedByLabel, stopReasonLabel } from "../domain/after-reply";
import { assertThreadBelongsToConversation, assertStepsBelongToVersion, isAnswered, planDueDates, startPosition } from "../domain/follow-ups";
import type { ConversationFollowUpState, RunSource, RunStore, StartFacts } from "./follow-up-ports";

/**
 * Use cases for the follow-ups of one conversation. The flow itself belongs to a campaign (see after-reply.ts); a run
 * pins the newest published version of the flow of the campaign that most recently emailed the person.
 * Nothing here sends: a run only schedules steps, and the job turns a due step into a draft a person approves or an allowed agent sends.
 */

export interface FollowUpDeps {
  runs: RunStore;
  now: () => Date;
}

/** The deps of a use case that needs only some of the store's methods, so a test fakes those alone. */
type DepsWith<K extends keyof RunStore> = { runs: Pick<RunStore, K>; now: () => Date };

// Starting runs ---------------------------------------------------------------------------------------

export interface StartRunInput {
  organizationId: string;
  conversationId: string;
  /** Defaults to the conversation holding the conversation's latest inbound message. */
  threadId?: string;
  source: RunSource;
  actorUserId?: string | null;
  /** Skip the reply step: a person already answered. */
  skipReply?: boolean;
  /** Replace a run in progress even when it matches the one that would start. */
  restart?: boolean;
}

/** The first reason no run can start from these facts, or null. The same words reach the Restart button and the 409. */
export function startBlocker(facts: StartFacts, input: { source: RunSource; skipReply?: boolean }): string | null {
  const { conversation } = facts;
  // The reply type's Follow-ups rule decides for both sources: `startBlockedReason` reads `conversation.followUps`.
  const blocked = startBlockedReason({
    conversation,
    thread: facts.thread,
    doNotContact: facts.doNotContact,
    suppressed: facts.suppressed,
    contact: facts.contact,
    owner: facts.owner,
    flow: facts.flow,
    stepCount: facts.steps.length,
    answered: isAnswered(conversation),
    skipReply: input.skipReply,
  });
  if (blocked) return blocked;
  // The owner passed every check but the store found no flow to run: a campaign or flow changed between the reads.
  return facts.selection ? null : "Follow-ups cannot start for this conversation right now.";
}

export type StartOutcome = { started: { runId: string; created: boolean } } | { blocked: string };

/**
 * Starts a run pinned to the newest published version of the owning campaign's flow, or answers why none can start
 * (no flow, the campaign is paused or in handoff mode, a reply type set to stop follow-ups). Proves the two facts
 * SQL cannot: the conversation belongs to the conversation, and every step belongs to the pinned version. A run already
 * started for the same message and version is returned as is.
 */
export async function attemptRun(deps: DepsWith<"loadStart" | "createRun">, input: StartRunInput): Promise<StartOutcome> {
  const facts = await deps.runs.loadStart(input.organizationId, input.conversationId, { threadId: input.threadId });
  if (!facts) throw new NotFoundError("Reply handling not found");
  const { conversation } = facts;
  if (facts.thread) assertThreadBelongsToConversation(facts.thread, conversation.id);
  const blocked = startBlocker(facts, { source: input.source, skipReply: input.skipReply });
  if (blocked || !facts.selection || !facts.thread || !conversation.replyTypeId || !conversation.latestInboundMessageId || !conversation.lastInboundAt) {
    return { blocked: blocked ?? "Follow-ups cannot start for this conversation right now." };
  }

  assertStepsBelongToVersion(facts.steps, facts.selection.followUpVersionId);
  const from = startPosition({ stepCount: facts.steps.length, answered: isAnswered(conversation), skipReply: input.skipReply, replyDraft: conversation.replyDraft });
  if (from === null) return { blocked: "A person already answered, and the flow has no follow-up step after the reply." };

  const now = deps.now();
  const due = planDueDates(now, facts.steps, from, facts.timeZone);
  const started = await deps.runs.createRun({
    organizationId: input.organizationId,
    conversationId: conversation.id,
    threadId: facts.thread.id,
    flowId: facts.selection.flowId,
    followUpVersionId: facts.selection.followUpVersionId,
    replyTypeId: conversation.replyTypeId,
    source: input.source,
    startPosition: from,
    triggerMessageId: conversation.latestInboundMessageId,
    lastInboundAtStart: conversation.lastInboundAt,
    contextVersion: conversation.contextVersion,
    steps: facts.steps.filter((s) => s.position >= from).map((s) => ({ stepId: s.id, position: s.position, dueAt: due.get(s.position) as Date })),
    actorUserId: input.actorUserId ?? null,
    restart: input.restart,
    now,
  });
  return { started };
}

/** Starts a run, or returns null when nothing applies. */
export async function startRun(deps: DepsWith<"loadStart" | "createRun">, input: StartRunInput): Promise<{ runId: string; created: boolean } | null> {
  const outcome = await attemptRun(deps, input);
  return "started" in outcome ? outcome.started : null;
}

// Per-conversation controls ---------------------------------------------------------------------------------

export interface ConversationAfterReply extends Omit<ConversationFollowUpState, "run"> {
  /** A person can restart the follow-ups now. */
  canRestart: boolean;
  /** Why Restart would fail, in plain words. Null when it can run. */
  restartBlockedReason: string | null;
  run:
    | (NonNullable<ConversationFollowUpState["run"]> & {
        statusLabel: string;
        startedByLabel: string;
        endedReasonLabel: string | null;
      })
    | null;
}

export async function getConversationFollowUp(deps: DepsWith<"conversationState" | "loadStart">, actor: Actor, conversationId: string): Promise<ConversationAfterReply> {
  // The two reads do not depend on each other, so they run together. A missing conversation fails the first and empties the second.
  const [state, facts] = await Promise.all([deps.runs.conversationState(actor.organizationId, conversationId), deps.runs.loadStart(actor.organizationId, conversationId, {})]);
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
export async function restartFollowUpRun(deps: DepsWith<"loadStart" | "createRun">, actor: Actor, conversationId: string, input: { threadId?: string } = {}) {
  const outcome = await attemptRun(deps, { organizationId: actor.organizationId, conversationId, threadId: input.threadId, source: "human_override", actorUserId: actor.userId, restart: true });
  if ("blocked" in outcome) throw new ConflictError(outcome.blocked, { code: "restart_blocked" });
  return outcome.started;
}

const event = (actor: Actor, conversationId: string) => ({ organizationId: actor.organizationId, conversationId, actorUserId: actor.userId, via: actor.via });

export const pauseFollowUpRun = (deps: FollowUpDeps, actor: Actor, conversationId: string) => deps.runs.pause(event(actor, conversationId), deps.now());

export const resumeFollowUpRun = (deps: FollowUpDeps, actor: Actor, conversationId: string) => deps.runs.resume(event(actor, conversationId), deps.now());

export const cancelFollowUpRun = (deps: FollowUpDeps, actor: Actor, conversationId: string) => deps.runs.cancel(event(actor, conversationId), "manual", deps.now());

export const skipFollowUpStep = (deps: FollowUpDeps, actor: Actor, conversationId: string) => deps.runs.skipStep(event(actor, conversationId), deps.now());
