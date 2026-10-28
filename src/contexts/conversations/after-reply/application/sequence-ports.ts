import type { AfterReplyMode } from "../domain/after-reply";
import type { FollowUpsRule, SystemRole } from "../../domain/reply-type";
import type { InterruptFacts, InterruptReason, RunStatus, StepInput, StepRunStatus, StepType } from "../domain/sequences";

/** Persistence for a campaign's Follow-ups after a reply flow. Every method carries the organization and filters by it. */

export type { SequenceStatus } from "../domain/sequences";
import type { SequenceStatus } from "../domain/sequences";

export interface StepView extends StepInput {
  id: string;
  sequenceVersionId: string;
  position: number;
  stepType: StepType;
}

/** The campaign facts the Follow-ups after a reply card needs. */
export interface FlowCampaign {
  id: string;
  name: string;
  channel: string;
  type: string;
  status: string;
}

export interface FlowRunRow {
  runId: string;
  recordId: string;
  /** The conversation the run follows up on. The campaign's own screen links to it. */
  conversationId: string;
  personName: string | null;
  status: RunStatus;
  currentStep: number;
  totalSteps: number;
  nextDueAt: Date | null;
  versionNumber: number;
}

/** What the card shows, as stored. The application derives the mode and the lock from it. */
export interface FlowState {
  campaign: FlowCampaign;
  /** The campaign-owned sequence, or null when the campaign never had one. */
  flow: { id: string; status: SequenceStatus } | null;
  /** Newest published version, or null. */
  published: { version: number } | null;
  /** The steps of the newest published version, else of the draft, else none. */
  steps: StepView[];
  /** Runs of the flow with status active or paused, newest first. */
  inProgress: FlowRunRow[];
  earlierVersionCount: number;
}

export interface FlowSave {
  organizationId: string;
  campaignId: string;
  actorUserId: string;
  mode: "handoff" | "ai_drafts";
  /** New steps for ai_drafts. Null keeps the stored ones. Ignored for handoff. */
  steps: StepInput[] | null;
  confirmStopRuns: boolean;
  now: Date;
}

/** Configuration side: a campaign's flow, its versions and steps. */
export interface AfterReplyStore {
  /** Null when the campaign does not exist in the organization. */
  state(organizationId: string, campaignId: string): Promise<FlowState | null>;
  /**
   * One transaction under the campaign's lock. ai_drafts creates the flow when the campaign has none, activates it,
   * and publishes the steps unless they equal the newest published version. handoff archives the flow, keeps its
   * steps and, when `confirmStopRuns` is set, ends the runs in progress as `after_reply_off`; without it, runs in
   * progress make it throw a ConflictError with code `runs_in_progress`. Returns how many runs it ended.
   */
  save(input: FlowSave): Promise<{ stoppedRuns: number }>;
  /**
   * The active reply types of the organization's default reply type set whose Follow-ups rule is Stop, in no set
   * order. The application sorts them. Before the set exists, the default types the seed would write, with their keys
   * as ids. The read writes nothing.
   */
  stopReplyTypes(organizationId: string): Promise<StopReplyTypeRow[]>;
}

/** A reply type whose Follow-ups rule is Stop, as stored. */
export interface StopReplyTypeRow {
  id: string;
  key: string;
  name: string;
  groupKey: string;
  systemRole: SystemRole | null;
  sortOrder: number;
}

// Runs ------------------------------------------------------------------------------------------------

export type RunSource = "ai_assignment" | "human_override";

export interface StartFacts {
  organizationId: string;
  record: {
    id: string;
    personId: string;
    replyTypeId: string | null;
    groupKey: string | null;
    replyTypeKey: string | null;
    replyTypeName: string | null;
    /** The Follow-ups rule the applied pick stored, else the type's (`startFollowUpsSql`), or null without a type. */
    followUps: FollowUpsRule | null;
    /** The Reply draft rule the applied pick stored, else the type's (`startReplyDraftSql`), or null without a type. False skips step 1. */
    replyDraft: boolean | null;
    latestInboundMessageId: string | null;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    contextVersion: number;
    workflowState: string;
    /** The person has an email address. */
    hasEmail: boolean;
    /** The latest reply asked to stop (`stopRequestedSql`), which starts no follow-ups. */
    stopRequested: boolean;
  };
  doNotContact: boolean;
  /** The person's address is on the suppression list. */
  suppressed: boolean;
  /** The person is a contact (`people.lifecycle`), who starts no follow-ups. */
  contact: boolean;
  /** The campaign that most recently emailed the person, whatever its state. Null when none did. */
  owner: { id: string; name: string; channel: string; type: string; status: string; archived: boolean } | null;
  /** The owner's Follow-ups after a reply sequence, whatever its state. Null when the owner has none. */
  flow: { status: SequenceStatus; hasPublished: boolean } | null;
  /** The conversation asked for, or the one holding the latest inbound message. */
  conversation: { id: string; recordId: string; channel: string } | null;
  /**
   * The flow to run and its newest published version: the active flow of the campaign that most recently emailed the
   * person. Null when that campaign is in handoff mode, is not startable, or the person was never emailed.
   */
  selection: { sequenceId: string; sequenceVersionId: string; campaignId: string } | null;
  steps: Array<{ id: string; sequenceVersionId: string; position: number; delayMinutes: number }>;
  timeZone: string;
}

export interface NewRun {
  organizationId: string;
  recordId: string;
  conversationId: string;
  sequenceId: string;
  sequenceVersionId: string;
  replyTypeId: string;
  source: RunSource;
  startPosition: number;
  triggerMessageId: string;
  lastInboundAtStart: Date;
  contextVersion: number;
  steps: Array<{ stepId: string; position: number; dueAt: Date }>;
  actorUserId: string | null;
  /** A person restarts the follow-ups: an identical run in progress ends and a fresh one starts. */
  restart?: boolean;
  now: Date;
}

export interface RecordSequenceState {
  recordId: string;
  /** The run's campaign, else the campaign that most recently emailed the person. */
  campaign: { id: string; name: string; mode: AfterReplyMode } | null;
  run: {
    id: string;
    status: RunStatus;
    version: number;
    currentStepPosition: number;
    totalSteps: number;
    startedBy: RunSource;
    createdAt: Date;
    /** Why the run ended, from the event written when it stopped. Null while it runs. */
    endedReason: string | null;
    steps: Array<{ id: string; position: number; name: string; status: StepRunStatus; dueAt: Date; draftId: string | null; lastError: string | null }>;
  } | null;
}

export interface RunEvent {
  organizationId: string;
  recordId: string;
  actorUserId: string | null;
}

/** Everything the manual run controls persist. */
export interface RunStore {
  loadStart(organizationId: string, recordId: string, opts: { conversationId?: string }): Promise<StartFacts | null>;
  /** Replaces the record's active run, in one transaction. Returns the existing run's id when an identical one already runs. */
  createRun(run: NewRun): Promise<{ runId: string; created: boolean }>;
  recordState(organizationId: string, recordId: string): Promise<RecordSequenceState | null>;
  pause(event: RunEvent, now: Date): Promise<void>;
  resume(event: RunEvent, now: Date, timeZone: string): Promise<void>;
  cancel(event: RunEvent, reason: string, now: Date): Promise<void>;
  skipStep(event: RunEvent, now: Date, timeZone: string): Promise<{ skipped: number; next: number | null }>;
  timeZone(organizationId: string): Promise<string>;
}

// Engine (the job) ------------------------------------------------------------------------------------

export interface ClaimedStep {
  stepRunId: string;
  organizationId: string;
  attempts: number;
  run: { id: string; recordId: string; conversationId: string; sequenceVersionId: string; triggerMessageId: string };
  step: StepView;
  timeZone: string;
}

export interface OpenDraft {
  id: string;
  status: string;
  replyForMessageId: string | null;
}

export interface InterruptCandidate {
  runId: string;
  organizationId: string;
  recordId: string;
  facts: InterruptFacts;
}

/** What the sequences job reads and writes each tick. */
export interface SequenceEngineStore {
  /** Records whose newest, classified inbound message has no run yet and whose owning campaign has an active flow. */
  startCandidates(limit: number): Promise<Array<{ organizationId: string; recordId: string }>>;
  /** Active and paused runs after `afterRunId`, with the facts that decide interruption. */
  interruptCandidates(afterRunId: string | null, limit: number): Promise<InterruptCandidate[]>;
  interrupt(organizationId: string, runId: string, reason: InterruptReason, now: Date): Promise<void>;
  /** Moves step runs whose draft was sent, discarded or superseded. Returns how many changed. */
  settleDrafts(now: Date, limit: number): Promise<number>;
  /** Takes one due step of an active run, or null. Steps drafting past the lease are taken over. */
  claimDue(workerId: string, now: Date, leaseMs: number): Promise<ClaimedStep | null>;
  /** Back to scheduled without using the attempt. */
  release(stepRunId: string, dueAt: Date, now: Date): Promise<void>;
  /** A drafting attempt failed: retried later, or failed for good. */
  failAttempt(stepRunId: string, error: string, retryAt: Date | null, now: Date): Promise<void>;
  openDrafts(organizationId: string, recordId: string): Promise<OpenDraft[]>;
  /** A draft this step run created earlier but never linked (a crash between the two writes). */
  orphanDraft(organizationId: string, stepRunId: string): Promise<string | null>;
  /** Links a draft to its step. False when a stop got there first: the step is no longer drafting or its run is over. */
  linkDraft(organizationId: string, stepRunId: string, draftId: string, now: Date): Promise<boolean>;
  /** Retires a draft written for a run that stopped while the draft was being written. */
  retireDraft(organizationId: string, draftId: string, now: Date): Promise<void>;
  knowledgeForTags(organizationId: string, tags: string[]): Promise<Array<{ documentVersionId: string; title: string; content: string }>>;
  /** Facts for the guard right before a draft is written. */
  interruptFactsFor(organizationId: string, runId: string): Promise<InterruptFacts | null>;
}
