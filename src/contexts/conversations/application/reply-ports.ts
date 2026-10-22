import type { AiPersonContext, DraftChannel, StageChange, TaxonomyEntry, ThreadEntry } from "../ai/domain/ai-contract";
import type { FailureKind } from "../ai/domain/ai-job-requeue";
import type { HoldReason } from "../domain/classification-policy";

export type JobKind = "classification" | "initial_draft";

export interface FailedAiJob {
  id: string;
  kind: JobKind;
  entityId: string;
  attempts: number;
  lastError: string;
  failedAt: Date;
  failureKind: FailureKind | null;
  autoRequeues: number;
  manualRequeues: number;
  requeueCeiling: number;
  /** Null when the sweep will not requeue it (permanent, shape or ceiling reached). */
  nextAutoRequeueAt: Date | null;
}

/** A job the unknown-sender cap (or another guard) set aside. It is not retried. */
export interface SkippedAiJob {
  id: string;
  kind: JobKind;
  entityId: string;
  reason: string;
  detail: string;
  skippedAt: Date;
}

export interface ClaimedJob {
  id: string;
  organizationId: string;
  kind: JobKind;
  entityId: string;
  attempts: number;
  maxAttempts: number;
}

/** What the classification worker needs to build a prompt and judge the answer. */
export interface ClassifyContext {
  recordId: string;
  contextVersion: number;
  latestInboundMessageId: string | null;
  categoryKey: string | null;
  categoryLocked: boolean;
  currentStageRank: number | null;
  settings: { autoApplyConfidence: number; reviewOther: boolean; customerRequiresReview: boolean };
  operatorInstructions: string;
  businessContext: string;
  taxonomy: Array<TaxonomyEntry & { id: string; reviewRequired: boolean; stageRank: number | null }>;
  person: AiPersonContext;
  thread: ThreadEntry[];
  messageText: string;
}

export interface FinishClassification {
  job: ClaimedJob;
  messageId: string;
  expectedContextVersion: number;
  proposedSubcategoryKey: string;
  confidence: number;
  reason: string;
  stopRequested: boolean;
  decision: { action: "auto_apply" } | { action: "hold"; reason: HoldReason };
  /** Whether an applied classification should queue a draft. */
  wantsDraft: boolean;
  provider: string;
  model: string;
  request: unknown;
  response: unknown;
}

export interface DraftContext {
  channel: DraftChannel;
  organizationId: string;
  recordId: string;
  conversationId: string;
  contextVersion: number;
  replyForMessageId: string | null;
  person: AiPersonContext;
  thread: ThreadEntry[];
  subject: string;
  classification: { id: string | null; subcategoryName: string; reason: string | null } | null;
  stageChange: StageChange | null;
  operatorInstructions: string;
  knowledge: Array<{ documentVersionId: string; title: string; content: string }>;
  senderName: string | null;
}

export interface NewDraft {
  organizationId: string;
  recordId: string;
  conversationId: string;
  replyForMessageId: string | null;
  expectedContextVersion: number;
  /** Null for LinkedIn: a chat message has no subject. */
  subject: string | null;
  bodyText: string;
  /** Defaults to email. */
  channel?: DraftChannel;
  provider: string;
  model: string;
  request: unknown;
  response: unknown;
  citations: Array<{ documentVersionId: string; excerpt: string }>;
  /** Draft this one replaces: it becomes `discarded`, and the lineage is recorded in `request`. */
  regeneratesDraftId?: string;
  /** Any other open draft of the record turns `stale`. */
}

export type DraftStatus = "generating" | "awaiting_review" | "sending" | "sent" | "discarded" | "stale" | "failed" | "delivery_uncertain";

export interface DraftRow {
  id: string;
  organizationId: string;
  recordId: string;
  conversationId: string;
  status: DraftStatus;
  revision: number;
  expectedContextVersion: number;
  subject: string | null;
  aiBodyText: string | null;
  editedBodyText: string | null;
  /** CC addresses a person chose for this reply. Empty unless someone picked them. */
  cc: string[];
  error: string | null;
  model: string | null;
  /** `manual` for a reply a person typed, `ai` otherwise. */
  source: "ai" | "manual";
  createdAt: Date;
  updatedAt: Date;
  /** Draft this one was regenerated from, and the reviewer's note. */
  regeneratedFrom: string | null;
  feedback: string | null;
}

export interface AttemptRow {
  id: string;
  draftId: string;
  status: "prepared" | "sending" | "sent" | "failed" | "delivery_uncertain" | "reconciled";
  error: string | null;
  rfcMessageId: string | null;
  providerMessageId: string | null;
}

export interface SendContext {
  attempt: AttemptRow;
  organizationId: string;
  conversationId: string;
  recordId: string;
  personId: string;
  recipient: string;
  /** CC addresses approved with the draft. */
  cc: string[];
  subject: string;
  bodyText: string;
  rfcMessageId: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  mailbox: { emailAddress: string; displayName: string | null; signatureHtml: string | null; status: string } | null;
}

export type BeginSend = { kind: "replay"; attempt: AttemptRow } | { kind: "started"; send: SendContext };

export type SendBlocker = "suppressed" | "do_not_contact" | "mailbox_unavailable" | "cc_blocked";

/** An address remembered from the thread that may be offered as CC. */
export interface KnownCc {
  email: string;
  lastSeenAt: Date;
  /** Set when the address cannot be a recipient. */
  blocked: "suppressed" | "do_not_contact" | null;
}

export interface PanelData {
  conversationId: string;
  recordId: string;
  channel: string;
  workflowState: string;
  contextVersion: number;
  recipient: string | null;
  /** Subject of the newest message in the thread, the base for a typed reply's subject. */
  lastSubject: string | null;
  category: { categoryKey: string; subcategoryKey: string | null; name: string; source: string } | null;
  classification: {
    id: string;
    status: string;
    proposed: { subcategoryKey: string; name: string; categoryKey: string } | null;
    confidence: number | null;
    reasoning: string | null;
    holdReason: HoldReason | null;
    stopRequested: boolean;
    error: string | null;
    current: boolean;
    /** A person looked at an applied classification (Mark reviewed, Looks right). */
    acknowledged: boolean;
  } | null;
  draft: (DraftRow & { attempt: AttemptRow | null }) | null;
  taxonomy: Array<{ key: string; name: string; categoryKey: string }>;
  suppressed: boolean;
  doNotContact: boolean;
  mailboxIssue: string | null;
  /** The latest inbound message already has an answer sent after it. */
  answered: boolean;
  /** CC addresses seen on this lead's inbound mail, newest first. Offered as optional CC on a reply. */
  knownCcs: KnownCc[];
}

/** Everything the reply use cases persist. Each method is one atomic step; none talks to a provider. */
export interface ReplyStore {
  panel(organizationId: string, conversationId: string): Promise<PanelData | null>;
  /** Null when the conversation does not exist. */
  draftContext(organizationId: string, conversationId: string): Promise<DraftContext | null>;
  draftContextForDraft(organizationId: string, draftId: string): Promise<(DraftContext & { draft: DraftRow }) | null>;
  insertDraft(draft: NewDraft & { feedback?: string | null }): Promise<{ id: string }>;
  getDraft(organizationId: string, draftId: string): Promise<DraftRow | null>;
  /**
   * A draft a person typed (source `manual`), written in `awaiting_review` for the record's current context version.
   * Older open drafts of the record turn `stale`. Refuses a conversation that is not an open email thread, a suppressed
   * address, a do-not-contact person, and a thread with a send in flight. 404 when the conversation is not in this organization.
   */
  createManualDraft(input: { organizationId: string; conversationId: string; subject: string; bodyText: string; cc: string[]; actorUserId: string }): Promise<{ id: string; revision: number }>;
  /** Like `ccContext`, for a conversation that has no draft yet. */
  ccContextForConversation(organizationId: string, conversationId: string): Promise<{ known: string[]; mailbox: string; lead: string | null } | null>;
  updateDraft(organizationId: string, draftId: string, input: { expectedRevision: number; subject: string | null; bodyText: string; cc?: string[] }): Promise<DraftRow>;
  /** What a CC choice is checked against. Null when the draft does not exist in this organization. */
  ccContext(organizationId: string, draftId: string): Promise<{ known: string[]; mailbox: string; lead: string | null } | null>;
  /** Which of these addresses are suppressed or belong to a do-not-contact person. */
  blockedAddresses(organizationId: string, emails: string[]): Promise<Array<{ email: string; reason: "suppressed" | "do_not_contact" }>>;
  discardDraft(organizationId: string, draftId: string, actorUserId: string): Promise<void>;

  beginSend(input: { organizationId: string; draftId: string; expectedRevision: number; idempotencyKey: string; actorUserId: string; messageIdToken: string }): Promise<BeginSend>;
  checkBlockers(send: SendContext): Promise<SendBlocker | null>;
  markSent(send: SendContext, sent: { providerMessageId: string; threadId: string | null }, now: Date, note?: string): Promise<void>;
  /** A definite refusal: nothing was sent. The draft goes back to review (or to `failed` for a blocker). */
  markFailed(send: SendContext, error: string, draftStatus: "awaiting_review" | "failed"): Promise<void>;
  markUncertain(send: SendContext, error: string): Promise<void>;
  /** Attempts with an unsettled outcome, for reconciliation. */
  listUnsettled(olderThan: Date, limit: number): Promise<Array<{ send: SendContext; status: "sending" | "delivery_uncertain"; startedAt: Date }>>;
  resolveUncertain(input: { organizationId: string; draftId: string; outcome: "delivered" | "not_delivered"; note: string; actorUserId: string; now: Date }): Promise<void>;

  /** Human classification. Returns what was applied and whether a draft job was queued. */
  applyHumanClassification(input: { organizationId: string; conversationId: string; subcategoryKey: string | null; expectedContextVersion: number; actorUserId: string; wantsDraft: (categoryKey: string, subcategoryKey: string) => boolean }): Promise<{ categoryKey: string; subcategoryKey: string; draftQueued: boolean }>;
  suppressSender(input: { organizationId: string; conversationId: string; actorUserId: string }): Promise<{ email: string }>;
}

/** Durable AI queue and the two job handlers' persistence. */
export interface AiJobStore {
  /** Queues a classification job for every record whose latest inbound message has none. */
  enqueueMissing(now: Date): Promise<number>;
  /** Takes one runnable job (queued and due, or running with an expired lease). Exhausted stale jobs are failed first. */
  claim(kind: JobKind, workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null>;
  /** Settles the claim only while this worker still holds it: a job reclaimed after its lease ran out belongs to the new claim. */
  complete(job: ClaimedJob, now: Date): Promise<void>;
  /** Back to queued without using the attempt, for a job that could not start (AI not configured). */
  release(job: ClaimedJob, runAfter: Date): Promise<void>;
  retry(job: ClaimedJob, error: string, runAfter: Date): Promise<void>;
  /** Final failure. `failureKind` decides whether the sweep may requeue it (default transient). */
  fail(job: ClaimedJob, error: string, now: Date, failureKind?: FailureKind): Promise<void>;

  /** Failed jobs of one organization, newest first, with the requeue state the jobs page shows. */
  listFailed(organizationId: string, limit: number): Promise<{ total: number; rows: FailedAiJob[] }>;
  /**
   * Admin requeue: failed jobs of this organization go back to queued with a fresh attempt budget, and a
   * classification job's `failed` record is removed so the new result can be stored. Only rows that are failed
   * now change, so a second call finds nothing. Returns the ids requeued.
   */
  requeueFailed(organizationId: string, filter: { jobId: string } | { since: Date }, now: Date, limit: number): Promise<string[]>;
  /** Whether a job with this id exists in this organization. */
  jobExists(organizationId: string, jobId: string): Promise<boolean>;
  /** Organizations that hold a failed job the sweep may requeue at `now`. */
  organizationsWithSweepable(now: Date): Promise<string[]>;
  /** Sweep requeue: the same transition as `requeueFailed`, limited to jobs that pass backoff, kind and ceiling. */
  requeueSweepable(organizationId: string, now: Date, limit: number): Promise<string[]>;

  /**
   * The unknown-sender cap. A reply from a sender the organization never wrote to counts against the daily limit (one place for its classification and draft together)
   * in the organization's general settings (default 50, day by the organization time zone). A job over the limit is
   * marked `skipped` with reason `daily_cap` and is not retried. Known senders and later attempts pass. Returns true
   * when the job was skipped.
   */
  skipOverCap(job: ClaimedJob, now: Date): Promise<boolean>;
  /** Skipped jobs of one organization, newest first. */
  listSkipped(organizationId: string, limit: number): Promise<{ total: number; rows: SkippedAiJob[] }>;

  loadClassifyContext(organizationId: string, messageId: string): Promise<ClassifyContext | null>;
  finishClassification(input: FinishClassification): Promise<{ status: "auto_applied" | "proposed" | "stale" }>;
  loadDraftContext(organizationId: string, classificationId: string): Promise<(DraftContext & { skip: string | null }) | null>;
}

export interface ReplySendRequest {
  mailbox: { emailAddress: string; displayName: string | null; signatureHtml: string | null };
  to: string;
  /** Visible CC recipients the approver chose. */
  cc: string[];
  subject: string;
  bodyText: string;
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  /** Used to build the one-click unsubscribe header the adapter adds. */
  organizationId: string;
}

export class ReplySendError extends Error {
  constructor(
    message: string,
    /** definite: the provider refused, nothing was sent. unknown: the message may have been accepted. */
    readonly kind: "definite" | "unknown",
  ) {
    super(message);
  }
}

export interface ReplyMailer {
  send(request: ReplySendRequest): Promise<{ providerMessageId: string; threadId: string | null }>;
  /** `absent` only after an exhaustive scan since `since`; `inconclusive` means the mailbox could not prove either way. */
  findSent(
    mailboxEmail: string,
    rfcMessageId: string,
    since: Date,
    hint?: { to?: string },
  ): Promise<
    | { status: "found"; sent: { providerMessageId: string; threadId: string | null } }
    | { status: "absent" }
    | { status: "inconclusive"; reason: string }
  >;
}
