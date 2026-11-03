import type { EnrollOptions } from "../../application/enroll-options";
import type { DbHandle } from "@/platform/db/client";
import type { AuditEntry, AuditSink } from "@/contexts/tenancy/application/audit-log";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { parseCampaignType, typeEditable, type ArchiveFilter, type CampaignStatus, type CampaignStatusChange, type CampaignType } from "../../domain/campaign";
import { archiveOn, changeStatusOn, createCampaignOn, deleteOn, enrollOn, enrollPickedOn, loadCampaign, removeLeadOn, removeLeadsOn, sendersOn, startProblemsOn, unarchiveOn, updateCampaignOn, type CampaignChannel, type CampaignLifecycleDeps } from "../../application/campaign-lifecycle";
import type { EnrollmentAdminStore, PickedEnrollCounts, RemoveCounts, SenderRef } from "../../application/enrollment-admin";
import { DEFAULT_LINKEDIN_STEPS, INVITE_NOTE_MAX, inviteNoteLength, renderLinkedInText, validateLinkedInSteps, type LinkedInStep } from "../domain/linkedin";
import type { EnrollmentListQuery, TabCounts } from "../../domain/enrollment-list";
import { sampleVariables } from "../../domain/variables";
import { unresolvedForLead, type MergeFieldSource } from "../../application/merge-fields";
import type { LeadCrossContext } from "../../application/cross-campaign-notices";
export interface LinkedInCampaignRecord {
  id: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  steps: LinkedInStep[];
  archivedAt: Date | null;
  createdAt: Date;
  /** Who created it. Null once that user is deleted. The creator may read a personal campaign's threads. */
  createdBy: string | null;
}

export interface LinkedInEnrollResult {
  /** People the query matched, or the ids a person picked. */
  requested: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  /** LinkedIn has no suppression list; do-not-contact is counted in `skippedDoNotContact`. */
  skippedSuppressed: number;
  added: number;
  alreadyEnrolled: number;
  skippedNoProfile: number;
  skippedDoNotContact: number;
  /** The latest reply reads as a request to stop and no person reviewed it. */
  skippedStopRequest: number;
  /** Contacts are not enrolled in campaigns. */
  skippedContact: number;
  /** People this call enrolled. Present only when the caller passed `collectIds`. */
  addedPersonIds?: string[];
  /** Dry run only: people the same call would enroll, up to the limit. */
  wouldAdd?: number;
}

export interface LinkedInEnrollmentRow {
  enrollmentId: string;
  personId: string;
  /** The Inbox conversation of a lead that replied (never a personal campaign's private thread), or null. */
  inboxConversationId: string | null;
  personName: string | null;
  profileUrl: string | null;
  status: string;
  stopReason: string | null;
  currentStep: number;
  connectionState: string;
  nextSendAt: Date | null;
  lastSentAt: Date | null;
  /** Merge-field values of this lead, with the campaign's per-lead overrides applied. */
  variables: Record<string, string | null>;
  /** Row panel: what went out, the retry state and the account behind it. */
  detail: LinkedInLeadDetail;
  /** The person has a private conversation under this (personal) campaign, whatever the enrollment status is now. */
  hasPrivateThread: boolean;
}

export interface LinkedInLeadDetail {
  headline: string | null;
  companyName: string | null;
  /** The account that sends for this lead, once one is pinned. */
  accountName: string | null;
  /** Sends of this lead, oldest step first. */
  sends: Array<{ stepNumber: number; status: string; attempt: number; sentAt: Date | null; claimedAt: Date; body: string | null; error: string | null }>;
  /** Failed invitation attempts so far of the latest send (the engine gives up after three). */
  retries: number;
  /** Latest send error, else the last profile lookup error. */
  lastError: string | null;
  /** Other campaigns the person is in. */
  alsoInCampaigns: LeadCrossContext["alsoInCampaigns"];
  /** LinkedIn accounts that already invited the person, so they cannot invite them again. */
  excludedAccounts: LeadCrossContext["excludedAccounts"];
}

/** An enrollment row as the page shows it: the variables are replaced by the expected note length. */
export interface LinkedInEnrollmentView extends Omit<LinkedInEnrollmentRow, "variables"> {
  /** Characters of the invitation note after merge fields. Null once the invitation went out or when the first step has no note. */
  noteLength: number | null;
  noteOverLimit: boolean;
}

/** What one connected account may still do today and this week. */
export interface LinkedInAccountLimits {
  id: string;
  name: string | null;
  username: string | null;
  status: string;
  dailyLimit: number;
  invitesToday: number;
  weeklyLimit: number;
  invitesThisWeek: number;
  /** Set while LinkedIn's own limit pauses the account. */
  limitReachedUntil: Date | null;
}

export interface LinkedInCampaignStore {
  list(organizationId: string, archived?: ArchiveFilter): Promise<Array<LinkedInCampaignRecord & { enrolled: number; invited: number; connected: number; replied: number }>>;
  /** Runs `fn` in one transaction, as a savepoint inside `within` when the caller already holds one. */
  transaction<T>(fn: (tx: DbHandle) => Promise<T>, within?: DbHandle): Promise<T>;
  get(organizationId: string, id: string, tx?: DbHandle): Promise<LinkedInCampaignRecord | null>;
  create(organizationId: string, input: { name: string; type?: CampaignType; createdBy: string; steps: LinkedInStep[] }, tx?: DbHandle): Promise<string>;
  furthestStep(organizationId: string, id: string, tx?: DbHandle): Promise<number>;
  /** Whether any send row exists for the campaign, in any status. */
  hasSends(organizationId: string, id: string, tx?: DbHandle): Promise<boolean>;
  /** A patch with steps applies only while the campaign is in `STEPS_EDITABLE`. Returns false when it no longer is. */
  update(organizationId: string, id: string, patch: { name?: string; type?: CampaignType; steps?: LinkedInStep[] }, tx?: DbHandle): Promise<boolean>;
  /** Returns false when the campaign moved off `change.from` or its steps changed since the check. */
  setStatus(organizationId: string, id: string, change: CampaignStatusChange<LinkedInStep>, tx?: DbHandle): Promise<boolean>;
  /** Deletes a draft. Returns false when no draft matched. */
  /** Deletes a draft and writes `audit` in one transaction. False when it is no longer a draft. */
  delete(organizationId: string, id: string, audit: AuditEntry): Promise<boolean>;
  /** Sets or clears `archivedAt`. Archiving applies to a completed campaign only. Returns false when no row matched. */
  setArchived(organizationId: string, id: string, archived: boolean): Promise<boolean>;
  /** People with a LinkedIn profile become enrollments with their LinkedIn progress row, in one transaction. */
  /** `collectIds` asks for `addedPersonIds` in the result. */
  /** With `dryRun` nothing is written and `wouldAdd` says how many people the same call would enroll. */
  /** `viaTokenId` names the agent's token on each inserted row (`enrolled_via_token_id`); null for a person. */
  enroll(organizationId: string, id: string, filter: { query?: string; limit: number; collectIds?: boolean; dryRun?: boolean; viaTokenId?: string | null }, tx?: DbHandle): Promise<LinkedInEnrollResult>;
  countConnectedAccounts(organizationId: string, tx?: DbHandle): Promise<number>;
  /** `total` counts the rows of the active tab and search. `counts` and `sent` cover the whole campaign. */
  listEnrollments(organizationId: string, id: string, query: EnrollmentListQuery): Promise<{ rows: LinkedInEnrollmentRow[]; total: number; counts: TabCounts; sent: number }>;
  /** Variables of the first enrolled person with a LinkedIn profile, or the first such lead; null when there are none. */
  sampleVariables(organizationId: string, id: string): Promise<Record<string, string | null> | null>;
  accountLimits(organizationId: string, now: Date): Promise<LinkedInAccountLimits[]>;
}

export interface LinkedInCampaignDeps {
  campaigns: LinkedInCampaignStore;
  fields: MergeFieldSource;
  audit: AuditSink;
  /** Set by composition. Hand-picked enroll, removal and senders need it. */
  admin?: EnrollmentAdminStore;
  /** Defaults to the system clock. Tests pass a fixed one. */
  now?: () => Date;
}

const lifecycle = (deps: LinkedInCampaignDeps): CampaignLifecycleDeps<LinkedInStep, LinkedInCampaignRecord, LinkedInEnrollResult> => deps;

const linkedin = (deps: LinkedInCampaignDeps): CampaignChannel<LinkedInStep> => ({
  channel: "linkedin",
  validateSteps: validateLinkedInSteps,
  tooFewSteps: (furthest) => `Some leads already completed step ${furthest}. The sequence cannot have fewer than ${furthest} steps.`,
  countConnectedSenders: (organizationId, tx) => deps.campaigns.countConnectedAccounts(organizationId, tx),
  noConnectedSender: "Connect a LinkedIn account in Settings before starting a campaign.",
});

const load = (deps: LinkedInCampaignDeps, actor: Actor, id: string, tx?: DbHandle) => loadCampaign(deps.campaigns, actor, id, tx);

export const listLinkedInCampaigns = (deps: LinkedInCampaignDeps, actor: Actor, archived: ArchiveFilter = "hide") => deps.campaigns.list(actor.organizationId, archived);

export const getLinkedInCampaign = (deps: LinkedInCampaignDeps, actor: Actor, id: string) => load(deps, actor, id);

export function createLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, input: { name: string; type?: CampaignType; senderIds?: string[] }, tx?: DbHandle): Promise<{ id: string }> {
  return createCampaignOn(lifecycle(deps), linkedin(deps), actor, input, (name) => ({ name, type: parseCampaignType(input.type), createdBy: actor.userId, steps: DEFAULT_LINKEDIN_STEPS }), tx);
}

/** The type can change until the campaign has sent something. */
export function updateLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, id: string, patch: { name?: string; type?: CampaignType; steps?: LinkedInStep[]; senderIds?: string[] }, tx?: DbHandle): Promise<void> {
  return updateCampaignOn(lifecycle(deps), linkedin(deps), actor, id, patch, tx, async (campaign) => {
    if (patch.type === undefined || patch.type === campaign.type) return {};
    if (!typeEditable(await deps.campaigns.hasSends(actor.organizationId, id, tx))) throw new ConflictError("The campaign type cannot change once the campaign has sent something.");
    return { type: parseCampaignType(patch.type) };
  });
}

/** The start problems of a draft or paused LinkedIn campaign, for a preview. Changes nothing. */
export async function linkedInStartProblems(deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<ValidationError[]> {
  return startProblemsOn(lifecycle(deps), linkedin(deps), actor, id, await load(deps, actor, id));
}

export function changeLinkedInCampaignStatus(deps: LinkedInCampaignDeps, actor: Actor, id: string, to: CampaignStatus, tx?: DbHandle): Promise<void> {
  return changeStatusOn(lifecycle(deps).campaigns, actor, id, to, (campaign) => startProblemsOn(lifecycle(deps), linkedin(deps), actor, id, campaign, tx), tx);
}

export const archiveLinkedInCampaign = (deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> => archiveOn(lifecycle(deps).campaigns, actor, id);

export const unarchiveLinkedInCampaign = (deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> => unarchiveOn(lifecycle(deps).campaigns, actor, id);

export const deleteLinkedInCampaign = (deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> => deleteOn(lifecycle(deps), "linkedin", actor, id);

export function enrollLinkedInLeads(deps: LinkedInCampaignDeps, actor: Actor, id: string, input: { query?: string; limit?: number; collectIds?: boolean; dryRun?: boolean }, options: EnrollOptions = {}, tx?: DbHandle): Promise<LinkedInEnrollResult> {
  return enrollOn(lifecycle(deps).campaigns, actor, id, input, options, tx);
}

/** Renders one step the way it would go out, with a real lead from the campaign when there is one. Unsaved edits can be passed in. */
export async function previewLinkedInStep(deps: LinkedInCampaignDeps, actor: Actor, id: string, stepNumber: number, draftSteps?: LinkedInStep[]) {
  const campaign = await load(deps, actor, id);
  const step = (draftSteps ?? campaign.steps)[stepNumber - 1];
  if (!step) throw new NotFoundError("Step not found");

  const real = await deps.campaigns.sampleVariables(actor.organizationId, id);
  const variables = real ?? sampleVariables();
  // Spin picks the first option, so the preview does not change between renders.
  const text = renderLinkedInText(step.body, variables, () => 0);
  const isInvitation = step.kind === "invitation";
  return {
    kind: step.kind,
    text,
    length: text.length,
    limit: isInvitation ? INVITE_NOTE_MAX : null,
    overLimit: isInvitation && text.length > INVITE_NOTE_MAX,
    usedSampleLead: real === null,
    leadName: (real?.fullName ?? real?.firstName ?? null) as string | null,
    unresolved: await unresolvedForLead(deps.fields, actor.organizationId, [step.body], variables),
  };
}

export async function getLinkedInCampaignDetail(deps: LinkedInCampaignDeps, actor: Actor, id: string, query: EnrollmentListQuery) {
  const campaign = await load(deps, actor, id);
  const now = (deps.now ?? (() => new Date()))();
  const [enrollments, accounts] = await Promise.all([
    deps.campaigns.listEnrollments(actor.organizationId, id, { ...query, campaignStatus: campaign.status }),
    deps.campaigns.accountLimits(actor.organizationId, now),
  ]);
  const invitation = campaign.steps[0]?.kind === "invitation" ? campaign.steps[0] : null;
  const rows: LinkedInEnrollmentView[] = enrollments.rows.map(({ variables, ...row }) => {
    const pending = invitation !== null && row.connectionState === "none" && (row.status === "pending" || row.status === "active");
    const noteLength = pending && invitation.body.trim() !== "" ? inviteNoteLength(invitation.body, variables) : null;
    return { ...row, noteLength, noteOverLimit: noteLength !== null && noteLength > INVITE_NOTE_MAX };
  });
  return { campaign, enrollments: { total: enrollments.total, counts: enrollments.counts, sent: enrollments.sent, rows }, accounts, connectedAccounts: accounts.filter((a) => a.status === "connected").length };
}

export async function enrollPickedLinkedInLeads(deps: LinkedInCampaignDeps, actor: Actor, id: string, personIds: string[], options: EnrollOptions = {}, tx?: DbHandle): Promise<PickedEnrollCounts & LinkedInEnrollResult> {
  const counts = await enrollPickedOn(lifecycle(deps), "linkedin", actor, id, personIds, options, tx);
  return { ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoProfile: counts.skippedMissingIdentity };
}

export const removeLinkedInLeads = (deps: LinkedInCampaignDeps, actor: Actor, id: string, enrollmentIds: string[]): Promise<RemoveCounts> => removeLeadsOn(lifecycle(deps), "linkedin", actor, id, enrollmentIds);

export const removeLinkedInLead = (deps: LinkedInCampaignDeps, actor: Actor, id: string, enrollmentId: string): Promise<{ removed: boolean; skippedFinal: boolean }> => removeLeadOn(lifecycle(deps), "linkedin", actor, id, enrollmentId);

export const getLinkedInCampaignSenders = (deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<{ assigned: SenderRef[]; available: SenderRef[] }> => sendersOn(lifecycle(deps), "linkedin", actor, id);
