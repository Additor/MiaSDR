import type { AiInstructionBlock, CategoryKey, PipelineSettingsPatch, SubcategoryInput, SubcategoryPatch } from "../domain/reply-handling";
import type { NoteScope } from "../actions/application/tasks-ports";

/** Read models and write ports for reply handling. Every method carries the organization and filters by it. */

export interface PipelineRef {
  id: string;
  name: string;
}

export interface TaxonomyRow {
  id: string;
  categoryKey: CategoryKey;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  active: boolean;
  reviewRequired: boolean;
  stageRank: number | null;
  sortOrder: number;
  recordCount: number;
  /** Classification rows that name this subcategory, so deleting it would break history. */
  historyCount: number;
}

export interface PipelineSettingsRow {
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
  draftInstructions: AiInstructionBlock[];
  classificationInstructions: AiInstructionBlock[];
}

export interface Taxonomy {
  pipeline: PipelineRef;
  subcategories: TaxonomyRow[];
  settings: PipelineSettingsRow;
}

export interface ClassificationEntry {
  id: string;
  status: string;
  messageId: string;
  conversationId: string;
  previous: { categoryKey: string | null; name: string | null };
  proposed: { categoryKey: string | null; name: string | null };
  applied: { categoryKey: string | null; name: string | null };
  confidence: number | null;
  reasoning: string | null;
  error: string | null;
  provider: string | null;
  acknowledged: boolean;
  createdAt: Date;
  /** Belongs to the record's latest inbound message. */
  latest: boolean;
  canUndo: boolean;
  canAcknowledge: boolean;
}

export interface DraftEntry {
  id: string;
  conversationId: string;
  channel: string;
  status: string;
  subject: string | null;
  preview: string;
  revision: number;
  createdAt: Date;
  attemptId: string | null;
}

export interface EventEntry {
  id: string;
  eventType: string;
  actorType: string;
  actorName: string | null;
  createdAt: Date;
  fromData: unknown;
  toData: unknown;
  meta: Record<string, unknown>;
}

export interface NoteEntry {
  id: string;
  title: string | null;
  body: string;
  createdAt: Date;
  authorName: string | null;
  createdBy: string | null;
}

export interface EnrollmentEntry {
  id: string;
  campaignId: string;
  campaignName: string;
  channel: string;
  status: string;
  stopReason: string | null;
}

export interface RecordDetail {
  record: {
    id: string;
    pipelineId: string;
    categoryKey: string | null;
    subcategoryId: string | null;
    subcategoryName: string | null;
    categorySource: string | null;
    categoryLocked: boolean;
    workflowState: string;
    activeChannel: string | null;
    contextVersion: number;
    latestInboundMessageId: string | null;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    nextActionAt: Date | null;
    closedReason: string | null;
    /** The member who handles the replies, or null while nobody does. */
    assignedTo: string | null;
    createdAt: Date;
  };
  person: { id: string; name: string | null; email: string | null; linkedinUrl: string | null; phone: string | null; title: string | null; company: string | null };
  policy: { doNotContact: boolean; reason: string | null; source: string | null; setAt: Date | null; clearedAt: Date | null } | null;
  suppressed: boolean;
  conversations: Array<{ id: string; channel: string; accountRef: string; status: string }>;
  classifications: ClassificationEntry[];
  drafts: DraftEntry[];
  events: EventEntry[];
  notes: NoteEntry[];
  enrollments: EnrollmentEntry[];
  stages: Array<{ id: string; key: string; categoryKey: CategoryKey; name: string; stageRank: number | null }>;
}

export interface StageMoveInput {
  organizationId: string;
  actorUserId: string;
  recordId: string;
  categoryKey: CategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  confirmUnlock: boolean;
  note: string | null;
  occurredAt: Date;
  now: Date;
}

export interface StageMoveResult {
  recordId: string;
  personId: string;
  categoryKey: string;
  subcategoryKey: string | null;
  contextVersion: number;
  draftsRetired: number;
}

export interface DncResult {
  changed: boolean;
  doNotContact: boolean;
  recordsUpdated: number;
  draftsRetired: number;
  enrollmentsStopped: number;
}

export interface IdentityExceptionRow {
  id: string;
  channel: string;
  accountRef: string;
  sourceEventKey: string;
  identityValue: string | null;
  reason: string;
  status: string;
  payload: unknown;
  resolvedPersonId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface NewIdentityException {
  organizationId: string;
  channel: string;
  accountRef: string;
  sourceEventKey: string;
  identityValue: string | null;
  reason: string;
  payload: unknown;
}

export interface ReplyHandlingStore {
  /** Everything but the conversation timelines, which the use case reads through the inbox store. */
  recordDetail(organizationId: string, recordId: string): Promise<RecordDetail | null>;
  draftIdForAttempt(organizationId: string, attemptId: string): Promise<string | null>;

  moveStage(input: StageMoveInput): Promise<StageMoveResult>;
  undoClassification(input: { organizationId: string; actorUserId: string; classificationId: string; now: Date }): Promise<{ recordId: string; draftsRetired: number }>;
  acknowledgeClassification(input: { organizationId: string; actorUserId: string; classificationId: string; now: Date }): Promise<void>;
  /** Sets or clears the person's do-not-contact flag and stops everything that would contact them. */
  setDoNotContact(input: { organizationId: string; actorUserId: string; personId: string; enabled: boolean; reason: string; now: Date }): Promise<DncResult>;
  closeRecord(input: { organizationId: string; actorUserId: string; recordId: string; reason: string; now: Date }): Promise<void>;
  reopenRecord(input: { organizationId: string; actorUserId: string; recordId: string; now: Date }): Promise<void>;
  /** NotFoundError when the record or person is not in the organization. */
  addNote(input: { organizationId: string; actorUserId: string; scope: NoteScope; title: string | null; body: string }): Promise<{ id: string }>;
  deleteNote(input: { organizationId: string; scope: NoteScope; noteId: string }): Promise<boolean>;

  taxonomy(organizationId: string): Promise<Taxonomy>;
  createSubcategory(organizationId: string, input: SubcategoryInput): Promise<{ id: string }>;
  updateSubcategory(organizationId: string, id: string, patch: SubcategoryPatch): Promise<void>;
  deleteSubcategory(organizationId: string, id: string): Promise<void>;
  updateSettings(organizationId: string, patch: PipelineSettingsPatch & { draftInstructions?: AiInstructionBlock[]; classificationInstructions?: AiInstructionBlock[] }): Promise<void>;

  listIdentityExceptions(organizationId: string, status: "open" | "resolved" | "ignored"): Promise<IdentityExceptionRow[]>;
  getIdentityException(organizationId: string, id: string): Promise<IdentityExceptionRow | null>;
  /** Idempotent on (channel, account, source event). Returns the row that now holds the event. */
  insertIdentityException(input: NewIdentityException): Promise<{ id: string; created: boolean }>;
  /** Marks an open exception resolved or ignored. False when it was no longer open. */
  closeIdentityException(input: { organizationId: string; id: string; outcome: { status: "resolved"; personId: string } | { status: "ignored" }; now: Date }): Promise<boolean>;
  /** Whether the person belongs to the organization, and the identifiers a replay needs. */
  personForReplay(organizationId: string, personId: string): Promise<{ id: string; email: string | null } | null>;
}
