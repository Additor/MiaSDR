import type { DbHandle } from "@/platform/db/client";
import type { ArchiveFilter, CampaignStatus, CampaignStatusChange, StepInput } from "../domain/campaign";
import type { EnrollmentListQuery, TabCounts } from "../domain/enrollment-list";
import type { WorkingHours } from "../domain/working-hours";

export interface CampaignSummary {
  id: string;
  name: string;
  status: CampaignStatus;
  steps: number;
  enrolled: number;
  sent: number;
  /** Leads that answered. Also counted in `stopped`. */
  replied: number;
  /** Replied, bounced, suppressed, failed or cancelled: out of the sequence before finishing. */
  stopped: number;
  completed: number;
  /** Sends the provider never confirmed, older than the grace period. A person has to settle them. */
  unconfirmed: number;
  archivedAt: Date | null;
  createdAt: Date;
}

/** A send in status `unknown`: the mail may or may not have gone out. */
export interface UnconfirmedSend {
  sendId: string;
  enrollmentId: string;
  personName: string | null;
  email: string | null;
  stepNumber: number;
  mailboxEmail: string | null;
  claimedAt: Date;
  /** The error recorded when the send went unknown (for example a provider timeout). */
  note: string | null;
}

export interface CampaignRecord {
  id: string;
  name: string;
  status: CampaignStatus;
  steps: StepInput[];
  archivedAt: Date | null;
  createdAt: Date;
}

export interface EnrollmentRow {
  enrollmentId: string;
  personId: string;
  /** The Inbox conversation of a lead that replied, or null. */
  inboxConversationId: string | null;
  personName: string | null;
  email: string | null;
  status: string;
  currentStep: number;
  nextSendAt: Date | null;
  lastSentAt: Date | null;
  stopReason: string | null;
}

export interface EnrollResult {
  /** People the query matched, or the ids a person picked. */
  requested: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  added: number;
  alreadyEnrolled: number;
  skippedSuppressed: number;
  skippedDoNotContact: number;
  /** Contacts are not enrolled in campaigns. */
  skippedContact: number;
  skippedNoEmail: number;
  /** Dry run only: people the same call would enroll, up to the limit. */
  wouldAdd?: number;
}

export interface CampaignStore {
  /** `now` fixes the clock for the unconfirmed-send count. */
  list(organizationId: string, now?: Date, archived?: ArchiveFilter): Promise<CampaignSummary[]>;
  /** Sends in status `unknown` claimed before `olderThan`: the total and the oldest `limit`. */
  unconfirmedSends(organizationId: string, id: string, olderThan: Date, limit: number): Promise<{ total: number; rows: UnconfirmedSend[] }>;
  get(organizationId: string, id: string, tx?: DbHandle): Promise<CampaignRecord | null>;
  /** Pass `tx` to make the insert part of the caller's transaction. */
  create(organizationId: string, input: { name: string; createdBy: string; steps: StepInput[] }, tx?: DbHandle): Promise<string>;
  /** The highest step any enrollment has completed. A sequence may not shrink below it. */
  furthestStep(organizationId: string, id: string): Promise<number>;
  /** A patch with steps applies only while the campaign is in `STEPS_EDITABLE`. Returns false when it no longer is. */
  update(organizationId: string, id: string, patch: { name?: string; steps?: StepInput[] }, tx?: DbHandle): Promise<boolean>;
  /** Returns false when the campaign moved off `change.from` or its steps changed since the check. */
  setStatus(organizationId: string, id: string, change: CampaignStatusChange<StepInput>): Promise<boolean>;
  delete(organizationId: string, id: string): Promise<void>;
  /** Sets or clears `archivedAt`. Archiving applies to a completed campaign only. Returns false when no row matched. */
  setArchived(organizationId: string, id: string, archived: boolean): Promise<boolean>;
  /** With `dryRun` nothing is written and `wouldAdd` says how many people the same call would enroll. */
  enroll(organizationId: string, id: string, filter: { query?: string; limit: number; dryRun?: boolean }, tx?: DbHandle): Promise<EnrollResult>;
  /** `total` counts the rows of the active tab and search. `counts` and `sent` cover the whole campaign. */
  listEnrollments(organizationId: string, id: string, query: EnrollmentListQuery): Promise<{ rows: EnrollmentRow[]; total: number; counts: TabCounts; sent: number }>;
  /** Variables of the first enrolled person, or the first lead with an email; null when there are no leads. */
  /** Active leads of this campaign whose pinned mailbox is disabled, failed or gone. Another mailbox takes them over after the delay. */
  waitingOnUnavailableMailbox(organizationId: string, id: string): Promise<number>;
  sampleVariables(organizationId: string, id: string): Promise<Record<string, string | null> | null>;
  /** Variables of up to `limit` live (not removed) enrollments, each with its own merge fields applied. */
  liveLeadVariables(organizationId: string, id: string, limit: number): Promise<Array<Record<string, string | null>>>;
}

export interface MailboxRecord {
  id: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  lastError: string | null;
  lastTestedAt: Date | null;
  dailySendLimit: number;
  signatureHtml: string | null;
  workingHours: WorkingHours | null;
  sentToday: number;
  /** Active leads pinned to this mailbox, whose follow-ups go out from it. */
  waitingLeads: number;
  createdAt: Date;
}

export interface MailboxStore {
  list(organizationId: string, now: Date): Promise<MailboxRecord[]>;
  get(organizationId: string, id: string): Promise<MailboxRecord | null>;
  /** Throws ConflictError when the address is already connected anywhere. */
  insert(organizationId: string, input: { emailAddress: string; displayName: string | null }): Promise<string>;
  update(organizationId: string, id: string, patch: Partial<Pick<MailboxRecord, "displayName" | "dailySendLimit" | "signatureHtml" | "workingHours">>): Promise<void>;
  setStatus(organizationId: string, id: string, status: "connecting" | "connected" | "failed" | "disabled", error: string | null, testedAt: Date | null): Promise<void>;
  /** Enrollments that finished a step from this mailbox and are still going. */
  activeEnrollmentCount(organizationId: string, id: string): Promise<number>;
  /** Names of campaigns that are not completed and list this mailbox as their only assigned sender. */
  soleSenderCampaigns(organizationId: string, id: string): Promise<string[]>;
  delete(organizationId: string, id: string): Promise<void>;
  countConnected(organizationId: string): Promise<number>;
  firstConnectedSignature(organizationId: string): Promise<string | null>;
}
