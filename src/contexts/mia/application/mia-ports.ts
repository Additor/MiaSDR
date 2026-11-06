import type { AiUsage } from "@/contexts/ai/domain/generation";
import type { BrainStore } from "@/contexts/brain/application/brain-items";
import type { BrainFields } from "@/contexts/brain/domain/brain-fields";
import type { BrainKind } from "@/contexts/brain/domain/brain-kinds";
import type { FitCriterion, FitInputs, FitVerdict } from "@/contexts/people/domain/lead-fit";
import type { FitBrainItem, FitOutput, FitSources } from "../domain/lead-fit";
import type { MiaCapability, MiaRunStatus } from "../domain/mia-run";
import type { MiaSettings } from "../domain/mia-settings";
import type { MiaSuggestionStatus, MiaSuggestionType, SuggestionPayload } from "../domain/suggestion";

export interface NewRun {
  capability: MiaCapability;
  requestedBy: string;
  input: Record<string, unknown>;
}

export interface ClaimedRun {
  id: string;
  organizationId: string;
  capability: MiaCapability;
  /** The lead a fit check reads. */
  personId: string | null;
  requestedBy: string | null;
  input: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  stepCount: number;
  usedTokens: number;
  suggestionCount: number;
  attempts: number;
  failures: number;
  claimToken: string;
}

export interface NewSuggestion {
  type: MiaSuggestionType;
  ordinal: number;
  targetItemId: string | null;
  kind: string;
  title: string;
  payload: SuggestionPayload;
}

export interface StepRecord {
  checkpoint: Record<string, unknown>;
  usage: AiUsage;
  provider: string;
  model: string;
  suggestions: readonly NewSuggestion[];
  /** Ends the run as succeeded. */
  finished: boolean;
  now: Date;
  leaseMs: number;
}

export interface RunFailure {
  error: string;
  failureKind: string;
  /** A rough count for a call whose answer never came. */
  chargedTokens?: number;
  now: Date;
}

/** The queue of runs. Every write that ends or uses a claim checks the claim first and answers false when it is gone. */
export interface MiaRunStore {
  create(organizationId: string, run: NewRun): Promise<{ id: string }>;
  /** Takes what is due, and what a worker that died left behind, which counts as a failure. */
  claim(now: Date, leaseMs: number, limit: number): Promise<ClaimedRun[]>;
  /** Whether anything could be claimed now. */
  hasDue(now: Date): Promise<boolean>;
  saveStep(run: ClaimedRun, step: StepRecord): Promise<boolean>;
  retryLater(run: ClaimedRun, at: Date, failure: RunFailure): Promise<boolean>;
  fail(run: ClaimedRun, failure: RunFailure): Promise<boolean>;
  /** Ends the run with what it already suggested. */
  succeed(run: ClaimedRun, now: Date): Promise<boolean>;
  cancelled(run: ClaimedRun, now: Date): Promise<boolean>;
  /** Hands the run back without a failure: the tick budget ended, or the day's tokens did. */
  release(run: ClaimedRun, at: Date, status: Extract<MiaRunStatus, "queued" | "waiting_limit">): Promise<boolean>;
  cancelRequested(run: ClaimedRun): Promise<boolean>;
  /** Tokens counted against the organization's limit today. */
  usedToday(organizationId: string, now: Date): Promise<number>;
  /** Stops a run. A running one stops at its next step. False when no such run is going. */
  requestCancel(organizationId: string, runId: string, actorUserId: string, now: Date): Promise<boolean>;
  /** Brain jobs that are going or ended a moment ago. Fit checks show on Leads instead. */
  recent(organizationId: string, now: Date): Promise<RunRow[]>;
  /** One queued fit check per person, under one batch. A person with a check already going is skipped. */
  createFitRuns(organizationId: string, request: { requestedBy: string; personIds: readonly string[] }): Promise<{ batchId: string; queued: number; skipped: number }>;
  /** Ends the run and stores its judgment in one transaction. False when the claim is gone; a person deleted meanwhile ends the run with nothing stored. */
  saveFit(run: ClaimedRun, fit: FitResult): Promise<boolean>;
  /** The organization's latest fit batch, while it runs and for a while after. */
  latestFitBatch(organizationId: string, now: Date): Promise<FitBatchRow | null>;
  /** Stops every check of the batch that has not ended. False when none is going. */
  cancelFitBatch(organizationId: string, batchId: string, actorUserId: string, now: Date): Promise<boolean>;
}

export interface FitResult {
  verdict: FitVerdict;
  icpItemId: string | null;
  criteria: FitCriterion[];
  missing: string[];
  inputs: FitInputs;
  usage: AiUsage;
  provider: string;
  model: string;
  now: Date;
}

export interface FitBatchRow {
  id: string;
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Queued or running. */
  going: number;
  /** Waiting for tomorrow's tokens. */
  waiting: number;
  /** The people whose check failed, for a second try. */
  failedPersonIds: string[];
  /** The first failure's reason, for the line that reports the batch. */
  firstError: string | null;
  createdAt: Date;
}

export interface RunRow {
  id: string;
  capability: MiaCapability;
  status: MiaRunStatus;
  /** The site's name, for a run that reads one. */
  site: string | null;
  suggestionCount: number;
  error: string | null;
  cancelRequested: boolean;
  nextAttemptAt: Date;
  createdAt: Date;
}

export interface SuggestionRecord {
  id: string;
  type: MiaSuggestionType;
  status: MiaSuggestionStatus;
  targetItemId: string | null;
  kind: string;
  title: string;
  payload: SuggestionPayload;
  createdAt: Date;
}

export interface DecidedSuggestion {
  status: Extract<MiaSuggestionStatus, "accepted" | "dismissed">;
  createdItemId?: string;
}

export interface MiaSuggestionStore {
  listOpen(organizationId: string, limit: number): Promise<SuggestionRecord[]>;
  countOpen(organizationId: string): Promise<number>;
  /**
   * Locks the suggestion and stores what `decide` returns, in one transaction with the Brain store it hands over, so a
   * failed save leaves the suggestion open and two people cannot both accept it. False when it is not in the organization.
   */
  decide(organizationId: string, id: string, actorUserId: string, now: Date, decide: (suggestion: SuggestionRecord, brain: BrainStore) => Promise<DecidedSuggestion>): Promise<boolean>;
}

/** What a run needs from Brain, and no more: a web run reads nothing through it but whether an item of that name exists. */
export interface MiaBrainPort {
  /** The active item a suggestion of this kind and title would change, if any. */
  findTarget(organizationId: string, kind: BrainKind, title: string): Promise<{ id: string } | null>;
  /** A document from before the kinds existed. Null when it is gone, or already sorted. */
  legacyDocument(organizationId: string, id: string): Promise<{ id: string; title: string; content: string } | null>;
  /** What the item holds now, to compare a suggestion with. */
  currentFields(organizationId: string, id: string): Promise<{ title: string; fields: BrainFields | null; revision: number } | null>;
  /** The active ICP and qualification items, which a fit check reads and nothing else. */
  fitItems(organizationId: string): Promise<FitBrainItem[]>;
}

/** What a fit check reads of people. Only the one person it judges: a run never sees another lead. */
export interface MiaLeadPort {
  /** Null when the person is gone. */
  fitInput(organizationId: string, personId: string): Promise<{ sources: FitSources; profileHash: string; latestInboundMessageId: string | null } | null>;
  /** The ids among these that are people of the organization. */
  existing(organizationId: string, ids: readonly string[]): Promise<string[]>;
}

/** One configured model, asked for a fit judgment. Built on the language model the replies use: a check calls no tool. */
export interface LeadFitAssessor {
  readonly provider: string;
  readonly model: string;
  assess(request: { system: string; prompt: string }): Promise<{ output: FitOutput; usage: AiUsage }>;
}

export interface LeadFitAssessorResolver {
  forOrganization(organizationId: string): Promise<LeadFitAssessor | null>;
}

export interface ReadPage {
  url: string;
  title: string;
  text: string;
  /** Same-site addresses the page links to. Only these, and the first address, can be opened. */
  links: string[];
}

export interface PageReader {
  /** Throws an `Error` whose message the model may read, for a page it could not get. `signal` ends the wait early. */
  read(url: string, signal?: AbortSignal): Promise<ReadPage>;
}

export interface MiaSettingsStore {
  read(organizationId: string): Promise<MiaSettings>;
  save(organizationId: string, actorUserId: string, patch: Partial<MiaSettings>): Promise<MiaSettings>;
}
