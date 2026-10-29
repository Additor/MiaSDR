import type { AiInstructionBlock, ReplyTypeGroup, ReplyHandlingSettingsPatch, ReplyTypeInput, ReplyTypePatch } from "../domain/reply-handling";
import type { HoldReason, ReplyTypeFacts, SystemRole, TypeRules } from "../domain/reply-type";
import type { NoteScope } from "../actions/application/tasks-ports";

/** Read models and write ports for reply handling. Every method carries the organization and filters by it. */

export interface ReplyTypeSetRef {
  id: string;
  name: string;
}

export interface ReplyTypeRow {
  id: string;
  groupKey: ReplyTypeGroup;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  active: boolean;
  /** The type's rules, as they apply to picks from now on. */
  rules: TypeRules;
  systemRole: SystemRole | null;
  sortOrder: number;
  recordCount: number;
  /** Picks that name this reply type, so deleting it would break history. */
  historyCount: number;
}

export interface ReplyHandlingSettingsRow {
  /** The confidence floor: an AI pick below it waits for a person. */
  autoApplyConfidence: number;
  draftInstructions: AiInstructionBlock[];
  classificationInstructions: AiInstructionBlock[];
}

export interface ReplyTypeCatalog {
  replyTypeSet: ReplyTypeSetRef;
  replyTypes: ReplyTypeRow[];
  settings: ReplyHandlingSettingsRow;
}

/** A reply type as a person's type change reads it: what it is and the rules it would apply. */
export interface ReplyTypeOption {
  id: string;
  key: string;
  groupKey: ReplyTypeGroup;
  name: string;
  systemRole: SystemRole | null;
  rules: TypeRules;
}

/** What `typeChangeOutcome` needs for one record: its current type, the active types it can move to, and the facts. */
export interface TypeChangeFacts {
  current: ReplyTypeOption | null;
  targets: ReplyTypeOption[];
  facts: Omit<ReplyTypeFacts, "confidence" | "currentType">;
}

export interface ReplyTypePickEntry {
  id: string;
  status: string;
  messageId: string;
  conversationId: string;
  previous: { groupKey: string | null; name: string | null };
  proposed: { groupKey: string | null; name: string | null };
  applied: { groupKey: string | null; name: string | null };
  appliedReplyTypeId: string | null;
  confidence: number | null;
  reasoning: string | null;
  error: string | null;
  provider: string | null;
  acknowledged: boolean;
  /** The type rules the pick was decided with. Null for a pick without a type. */
  rules: TypeRules | null;
  /** System role of the proposed type, so the thread can tell a held stop request apart. */
  proposedSystemRole: SystemRole | null;
  /** The proposed type is still active. False once an admin archived it, or when the pick proposed no type. Accept refuses an archived type. */
  proposedActive: boolean;
  /** Why the AI held the pick for a person, from the pick's response. Null when it applied. */
  holdReason: HoldReason | null;
  /** The reply asked to stop, as the AI read it. */
  stopRequested: boolean;
  createdAt: Date;
  /** Belongs to the record's latest inbound message. */
  latest: boolean;
  /** Decided on the record's current context version and not stale, so Accept and Looks right still apply to it. */
  current: boolean;
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
  /** The record's context version the draft was written for. */
  expectedContextVersion: number;
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
    replyTypeSetId: string;
    groupKey: string | null;
    replyTypeId: string | null;
    replyTypeName: string | null;
    replyTypeSource: string | null;
    replyTypeLocked: boolean;
    /** Rules of the record's type as they stand now, archived types included. Null without a type. */
    replyTypeRules: TypeRules | null;
    replyTypeSystemRole: SystemRole | null;
    /** The initial draft job of the latest pick of the latest reply is queued or running, and that pick is applied at the record's version. */
    draftJobPending: boolean;
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
  replyTypePicks: ReplyTypePickEntry[];
  drafts: DraftEntry[];
  events: EventEntry[];
  notes: NoteEntry[];
  enrollments: EnrollmentEntry[];
  /** Active reply types in group order, the targets of Change type. */
  replyTypes: ReplyTypeOption[];
}

export interface ReplyTypeChangeInput {
  organizationId: string;
  actorUserId: string;
  recordId: string;
  groupKey: ReplyTypeGroup;
  replyTypeId: string | null;
  expectedContextVersion: number;
  confirmUnlock: boolean;
  note: string | null;
  occurredAt: Date;
  now: Date;
}

export interface ReplyTypeChangeResult {
  recordId: string;
  personId: string;
  groupKey: string;
  replyTypeKey: string | null;
  contextVersion: number;
  draftsRetired: number;
  /** A follow-up run of the owning campaign started for the new type. */
  runStarted: boolean;
}

/** What an undo retired, so the client can say it. */
export interface UndoReplyTypePickResult {
  recordId: string;
  /** Open drafts of the record that turned stale. */
  draftsRetired: number;
  /** An active or paused follow-up run ended. */
  runEnded: boolean;
  /** The undone pick's draft job will write nothing a person can send: a queued job was cancelled, or a running one writes its draft as stale. */
  draftJobCancelled: boolean;
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

/** The one store call an ingest path makes when it parks a message. `quarantineInbound` takes only this. */
export interface IdentityExceptionIntake {
  /** Idempotent on (channel, account, source event). Returns the row that now holds the event. */
  insertIdentityException(input: NewIdentityException): Promise<{ id: string; created: boolean }>;
}

export interface ReplyHandlingStore extends IdentityExceptionIntake {
  /** Everything but the conversation timelines, which the use case reads through the inbox store. */
  recordDetail(organizationId: string, recordId: string): Promise<RecordDetail | null>;
  draftIdForAttempt(organizationId: string, attemptId: string): Promise<string | null>;
  /** Null when the record is not in the organization or has only private conversations. */
  typeChangeFacts(organizationId: string, recordId: string): Promise<TypeChangeFacts | null>;

  changeReplyType(input: ReplyTypeChangeInput): Promise<ReplyTypeChangeResult>;
  undoReplyTypePick(input: { organizationId: string; actorUserId: string; replyTypePickId: string; now: Date }): Promise<UndoReplyTypePickResult>;
  acknowledgeReplyTypePick(input: { organizationId: string; actorUserId: string; replyTypePickId: string; now: Date }): Promise<void>;
  /** Sets or clears the person's do-not-contact flag and stops everything that would contact them. */
  setDoNotContact(input: { organizationId: string; actorUserId: string; personId: string; enabled: boolean; reason: string; now: Date }): Promise<DncResult>;
  closeRecord(input: { organizationId: string; actorUserId: string; recordId: string; reason: string; now: Date }): Promise<void>;
  reopenRecord(input: { organizationId: string; actorUserId: string; recordId: string; now: Date }): Promise<void>;
  /** NotFoundError when the record or person is not in the organization. */
  addNote(input: { organizationId: string; actorUserId: string; scope: NoteScope; title: string | null; body: string }): Promise<{ id: string }>;
  deleteNote(input: { organizationId: string; scope: NoteScope; noteId: string }): Promise<boolean>;

  replyTypeCatalog(organizationId: string): Promise<ReplyTypeCatalog>;
  /** The confidence floor and the AI instructions, without the types and their counts. */
  replySettings(organizationId: string): Promise<ReplyHandlingSettingsRow>;
  createReplyType(organizationId: string, input: ReplyTypeInput): Promise<{ id: string }>;
  updateReplyType(organizationId: string, id: string, patch: ReplyTypePatch): Promise<void>;
  deleteReplyType(organizationId: string, id: string): Promise<void>;
  updateSettings(organizationId: string, patch: ReplyHandlingSettingsPatch & { draftInstructions?: AiInstructionBlock[]; classificationInstructions?: AiInstructionBlock[] }): Promise<void>;

  listIdentityExceptions(organizationId: string, status: "open" | "resolved" | "ignored"): Promise<IdentityExceptionRow[]>;
  getIdentityException(organizationId: string, id: string): Promise<IdentityExceptionRow | null>;
  /** Marks an open exception resolved or ignored. False when it was no longer open. */
  closeIdentityException(input: { organizationId: string; id: string; outcome: { status: "resolved"; personId: string } | { status: "ignored" }; now: Date }): Promise<boolean>;
  /** Whether the person belongs to the organization, and the identifiers a replay needs. */
  personForReplay(organizationId: string, personId: string): Promise<{ id: string; email: string | null } | null>;
}
