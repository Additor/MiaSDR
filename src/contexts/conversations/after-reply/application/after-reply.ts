import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { afterReplyLockedReason as lockedReasonOf, afterReplyModeOf, isAfterReplyMode, type AfterReplyMode } from "../domain/after-reply";
import { assertPublishable, parseSteps, type RunStatus, type StepInput, type StepType } from "../domain/sequences";
import type { AfterReplyStore, FlowCampaign, FlowRunRow, FlowState } from "./sequence-ports";

/**
 * The campaign setting After a reply. A campaign either hands a classified reply to the Inbox (`handoff`) or lets the
 * AI draft timed follow-ups that a person approves (`ai_drafts`). Any member of the organization can change it, as
 * with the campaign steps. Nothing here sends: the flow only asks for drafts.
 */

export interface AfterReplyDeps {
  flows: AfterReplyStore;
  now: () => Date;
}

/** One step of the flow. The delay is in minutes, as in the domain. */
export interface AfterReplyStepView {
  stepType: StepType;
  name: string;
  delayMinutes: number;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  aiInstructions: string;
  knowledgeTags: string[];
}

export interface AfterReplyRunRow {
  runId: string;
  recordId: string;
  /** The Inbox thread the run follows up on. */
  conversationId: string;
  personName: string | null;
  /** `active` or `paused`: the card lists runs in progress. */
  status: RunStatus;
  currentStep: number;
  totalSteps: number;
  nextDueAt: Date | null;
  versionNumber: number;
}

export interface AfterReplyView {
  campaignId: string;
  mode: AfterReplyMode;
  /** Steps of the newest published version. Empty when the campaign never had a flow. */
  steps: AfterReplyStepView[];
  versionNumber: number | null;
  /** The engine drafts for email campaigns of the regular type only. */
  supported: boolean;
  /** Why the mode is locked to handoff, or null. */
  lockedReason: string | null;
  inProgress: AfterReplyRunRow[];
  /** Runs in progress that started on a version older than the newest one. */
  earlierVersionCount: number;
}

export interface AfterReplyInput {
  mode: unknown;
  steps?: unknown;
  confirmStopRuns?: unknown;
}

export interface SaveAfterReplyResult extends AfterReplyView {
  stoppedRuns: number;
}

/** Why a campaign cannot draft follow-ups, or null when it can. */
export const afterReplyLockedReason: (campaign: Pick<FlowCampaign, "channel" | "type">) => string | null = lockedReasonOf;

function toView(state: FlowState): AfterReplyView {
  const lockedReason = afterReplyLockedReason(state.campaign);
  return {
    campaignId: state.campaign.id,
    mode: afterReplyModeOf(state.flow ? { status: state.flow.status, hasPublishedVersion: state.published !== null } : null),
    steps: state.steps.map((s) => ({
      stepType: s.stepType,
      name: s.name,
      delayMinutes: s.delayMinutes,
      subjectTemplate: s.subjectTemplate,
      bodyTemplate: s.bodyTemplate,
      aiInstructions: s.aiInstructions,
      knowledgeTags: s.knowledgeTags,
    })),
    versionNumber: state.published?.version ?? null,
    supported: lockedReason === null,
    lockedReason,
    inProgress: state.inProgress.map((r: FlowRunRow) => ({ ...r })),
    earlierVersionCount: state.earlierVersionCount,
  };
}

async function loadState(deps: AfterReplyDeps, actor: Actor, campaignId: string): Promise<FlowState> {
  const state = await deps.flows.state(actor.organizationId, campaignId);
  if (!state) throw new NotFoundError("Campaign not found");
  return state;
}

export async function getCampaignAfterReply(deps: AfterReplyDeps, actor: Actor, campaignId: string): Promise<AfterReplyView> {
  return toView(await loadState(deps, actor, campaignId));
}

/**
 * Saves the setting. `ai_drafts` stores the steps and publishes them in one step (no new version when they equal
 * the newest published ones). `handoff` archives the flow and keeps its steps; runs in progress stop only after
 * `confirmStopRuns: true`, otherwise the answer is a ConflictError with code `runs_in_progress` and their count.
 */
export async function saveCampaignAfterReply(deps: AfterReplyDeps, actor: Actor, campaignId: string, input: AfterReplyInput): Promise<SaveAfterReplyResult> {
  if (!isAfterReplyMode(input.mode)) throw new ValidationError("Mode must be handoff or ai_drafts.");
  const mode = input.mode;
  const current = await loadState(deps, actor, campaignId);

  let steps: StepInput[] | null = null;
  if (mode === "ai_drafts") {
    const locked = afterReplyLockedReason(current.campaign);
    if (locked) throw new ConflictError(locked, { code: "mode_locked" });
    if (input.steps !== undefined) {
      steps = parseSteps(input.steps);
      if (steps.length === 0) throw new ConflictError("Add the reply step before turning on AI drafts.", { code: "steps_required" });
      assertPublishable(steps);
    } else if (current.steps.length === 0) {
      throw new ConflictError("Add the reply step before turning on AI drafts.", { code: "steps_required" });
    }
  } else if (current.inProgress.length > 0 && input.confirmStopRuns !== true) {
    const count = current.inProgress.length;
    throw new ConflictError(`${count} follow-up${count === 1 ? "" : "s"} in progress will stop. Confirm to switch off.`, { code: "runs_in_progress", count });
  }

  const { stoppedRuns } = await deps.flows.save({
    organizationId: actor.organizationId,
    campaignId,
    actorUserId: actor.userId,
    mode,
    steps,
    confirmStopRuns: input.confirmStopRuns === true,
    now: deps.now(),
  });
  return { ...toView(await loadState(deps, actor, campaignId)), stoppedRuns };
}
