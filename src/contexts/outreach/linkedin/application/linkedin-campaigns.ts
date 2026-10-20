import { inTransaction, type DbHandle } from "@/platform/db/client";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { parseCampaignType, canArchive, canTransition, stepsEditable, typeEditable, type ArchiveFilter, type CampaignStatus, type CampaignType } from "../../domain/campaign";
import { MAX_PICKED_IDS, adminStore, assertAssignedSendersConnected, removeCampaignEnrollment, removeCampaignEnrollments, validateSenderIds, type EnrollmentAdminStore, type PickedEnrollCounts, type RemoveCounts, type SenderRef } from "../../application/enrollment-admin";
import { DEFAULT_LINKEDIN_STEPS, INVITE_NOTE_MAX, inviteNoteLength, renderLinkedInText, validateLinkedInSteps, type LinkedInStep } from "../domain/linkedin";
import type { EnrollmentListQuery, TabCounts } from "../../domain/enrollment-list";
import { sampleVariables, unresolvedTokens } from "../../domain/variables";
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
  get(organizationId: string, id: string, tx?: DbHandle): Promise<LinkedInCampaignRecord | null>;
  create(organizationId: string, input: { name: string; type?: CampaignType; createdBy: string; steps: LinkedInStep[] }, tx?: DbHandle): Promise<string>;
  furthestStep(organizationId: string, id: string): Promise<number>;
  /** Whether any send row exists for the campaign, in any status. */
  hasSends(organizationId: string, id: string): Promise<boolean>;
  update(organizationId: string, id: string, patch: { name?: string; type?: CampaignType; steps?: LinkedInStep[] }, tx?: DbHandle): Promise<void>;
  setStatus(organizationId: string, id: string, status: CampaignStatus): Promise<void>;
  delete(organizationId: string, id: string): Promise<void>;
  /** Sets or clears `archivedAt`. Archiving applies to a completed campaign only. Returns false when no row matched. */
  setArchived(organizationId: string, id: string, archived: boolean): Promise<boolean>;
  /** People with a LinkedIn profile become enrollments with their LinkedIn progress row, in one transaction. */
  /** `collectIds` asks for `addedPersonIds` in the result. */
  /** With `dryRun` nothing is written and `wouldAdd` says how many people the same call would enroll. */
  enroll(organizationId: string, id: string, filter: { query?: string; limit: number; collectIds?: boolean; dryRun?: boolean }, tx?: DbHandle): Promise<LinkedInEnrollResult>;
  countConnectedAccounts(organizationId: string): Promise<number>;
  /** `total` counts the rows of the active tab and search. `counts` and `sent` cover the whole campaign. */
  listEnrollments(organizationId: string, id: string, query: EnrollmentListQuery): Promise<{ rows: LinkedInEnrollmentRow[]; total: number; counts: TabCounts; sent: number }>;
  /** Variables of the first enrolled person with a LinkedIn profile, or the first such lead; null when there are none. */
  sampleVariables(organizationId: string, id: string): Promise<Record<string, string | null> | null>;
  accountLimits(organizationId: string, now: Date): Promise<LinkedInAccountLimits[]>;
}

export interface LinkedInCampaignDeps {
  campaigns: LinkedInCampaignStore;
  /** Set by composition. Hand-picked enroll, removal and senders need it. */
  admin?: EnrollmentAdminStore;
  /** Defaults to the system clock. Tests pass a fixed one. */
  now?: () => Date;
}

const PLACEHOLDER = /\[\[[^\]]*\]\]/;

const cleanName = (name: string) => {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 120) throw new ValidationError("Give the campaign a name of up to 120 characters.");
  return trimmed;
};

async function load(deps: LinkedInCampaignDeps, actor: Actor, id: string, tx?: DbHandle) {
  const campaign = await deps.campaigns.get(actor.organizationId, id, tx);
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign;
}

export const listLinkedInCampaigns = (deps: LinkedInCampaignDeps, actor: Actor, archived: ArchiveFilter = "hide") => deps.campaigns.list(actor.organizationId, archived);

export const getLinkedInCampaign = (deps: LinkedInCampaignDeps, actor: Actor, id: string) => load(deps, actor, id);

export async function createLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, input: { name: string; type?: CampaignType; senderIds?: string[] }, tx?: DbHandle): Promise<{ id: string }> {
  const name = cleanName(input.name);
  const type = parseCampaignType(input.type);
  const senderIds = await validateSenderIds(adminStore(deps), actor, "linkedin", input.senderIds ?? []);
  // One transaction: a campaign that fails to take its senders must not exist, or it would send from every account.
  const id = await inTransaction(tx, async (t) => {
    const created = await deps.campaigns.create(actor.organizationId, { name, type, createdBy: actor.userId, steps: DEFAULT_LINKEDIN_STEPS }, t);
    if (senderIds.length > 0) await adminStore(deps).replaceSenders(actor.organizationId, created, "linkedin", senderIds, t);
    return created;
  });
  return { id };
}

export async function updateLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, id: string, patch: { name?: string; type?: CampaignType; steps?: LinkedInStep[]; senderIds?: string[] }): Promise<void> {
  const campaign = await load(deps, actor, id);
  const next: { name?: string; type?: CampaignType; steps?: LinkedInStep[] } = {};
  const senderIds = patch.senderIds === undefined ? undefined : await validateSenderIds(adminStore(deps), actor, "linkedin", patch.senderIds);
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.type !== undefined && patch.type !== campaign.type) {
    if (!typeEditable(await deps.campaigns.hasSends(actor.organizationId, id))) throw new ConflictError("The campaign type cannot change once the campaign has sent something.");
    next.type = parseCampaignType(patch.type);
  }
  if (patch.steps !== undefined) {
    if (!stepsEditable(campaign.status)) throw new ConflictError("Pause the campaign before editing its steps.");
    const issues = validateLinkedInSteps(patch.steps);
    if (issues.length > 0) throw new ValidationError("Fix the steps and save again.", issues);
    const furthest = await deps.campaigns.furthestStep(actor.organizationId, id);
    if (patch.steps.length < furthest) throw new ConflictError(`Some leads already completed step ${furthest}. The sequence cannot have fewer than ${furthest} steps.`);
    next.steps = patch.steps;
  }
  // One transaction: a failed sender replacement must not leave the new name or steps behind.
  await inTransaction(undefined, async (tx) => {
    await deps.campaigns.update(actor.organizationId, id, next, tx);
    if (senderIds !== undefined) await adminStore(deps).replaceSenders(actor.organizationId, id, "linkedin", senderIds, tx);
  });
}

export async function changeLinkedInCampaignStatus(deps: LinkedInCampaignDeps, actor: Actor, id: string, to: CampaignStatus): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (campaign.archivedAt) throw new ConflictError(`An archived campaign cannot be ${to === "active" ? "started" : "changed"}. Unarchive it first.`);
  if (!canTransition(campaign.status, to)) throw new ConflictError(`A ${campaign.status} campaign cannot become ${to}.`);
  if (to === "active") {
    const issues = validateLinkedInSteps(campaign.steps);
    if (issues.length > 0) throw new ValidationError("Fix the steps before starting.", issues);
    const unfinished = campaign.steps.filter((s) => PLACEHOLDER.test(s.body)).map((s) => s.stepNumber);
    if (unfinished.length > 0) throw new ValidationError(`Replace the [[bracketed text]] in step ${unfinished.join(", ")} before starting.`);
    await assertAssignedSendersConnected(adminStore(deps), actor, "linkedin", id);
    if ((await deps.campaigns.countConnectedAccounts(actor.organizationId)) === 0) {
      throw new ValidationError("Connect a LinkedIn account in Settings before starting a campaign.");
    }
  }
  await deps.campaigns.setStatus(actor.organizationId, id, to);
}

/** Hides a completed campaign from the default list. Its sends, enrollments and analytics stay. */
export async function archiveLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (campaign.archivedAt) return;
  if (!canArchive(campaign.status)) throw new ConflictError("Only a completed campaign can be archived. Mark it completed first.");
  if (!(await deps.campaigns.setArchived(actor.organizationId, id, true))) throw new ConflictError("The campaign changed. Reload and try again.");
}

export async function unarchiveLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (!campaign.archivedAt) return;
  await deps.campaigns.setArchived(actor.organizationId, id, false);
}

export async function deleteLinkedInCampaign(deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (campaign.status !== "draft") throw new ConflictError("Only a draft campaign can be deleted. Pause it or mark it completed instead.");
  await deps.campaigns.delete(actor.organizationId, id);
}

export async function enrollLinkedInLeads(deps: LinkedInCampaignDeps, actor: Actor, id: string, input: { query?: string; limit?: number; collectIds?: boolean; dryRun?: boolean }, tx?: DbHandle): Promise<LinkedInEnrollResult> {
  const campaign = await load(deps, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 5000)), 5000);
  return deps.campaigns.enroll(actor.organizationId, id, { query: input.query?.trim() || undefined, limit, collectIds: input.collectIds, dryRun: input.dryRun }, tx);
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
    unresolved: unresolvedTokens([step.body], variables),
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

/** Enrolls the people a person ticked. Ids of another organization count as not found. */
export async function enrollPickedLinkedInLeads(deps: LinkedInCampaignDeps, actor: Actor, id: string, personIds: string[], tx?: DbHandle): Promise<PickedEnrollCounts & LinkedInEnrollResult> {
  const campaign = await load(deps, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  if (personIds.length === 0) throw new ValidationError("Pick at least one lead.");
  if (personIds.length > MAX_PICKED_IDS) throw new ValidationError(`Add up to ${MAX_PICKED_IDS} leads at a time.`);
  const counts = await adminStore(deps).enrollPicked(actor.organizationId, id, "linkedin", personIds, tx);
  return { ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoProfile: counts.skippedMissingIdentity };
}

/** Takes leads out of a LinkedIn campaign. The enrollment keeps its history and the person stays in Leads. */
export async function removeLinkedInLeads(deps: LinkedInCampaignDeps, actor: Actor, id: string, enrollmentIds: string[]): Promise<RemoveCounts> {
  await load(deps, actor, id);
  return removeCampaignEnrollments(deps, actor, "linkedin", id, enrollmentIds);
}

export async function removeLinkedInLead(deps: LinkedInCampaignDeps, actor: Actor, id: string, enrollmentId: string): Promise<{ removed: boolean; skippedFinal: boolean }> {
  await load(deps, actor, id);
  return removeCampaignEnrollment(deps, actor, "linkedin", id, enrollmentId);
}

/** The campaign's assigned accounts and every account of the organization, for the sender picker. */
export async function getLinkedInCampaignSenders(deps: LinkedInCampaignDeps, actor: Actor, id: string): Promise<{ assigned: SenderRef[]; available: SenderRef[] }> {
  await load(deps, actor, id);
  const [assigned, available] = await Promise.all([adminStore(deps).listSenders(actor.organizationId, id, "linkedin"), adminStore(deps).listAvailableSenders(actor.organizationId, "linkedin")]);
  return { assigned, available };
}
