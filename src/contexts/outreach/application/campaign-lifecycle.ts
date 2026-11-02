import type { DbHandle } from "@/platform/db/client";
import type { AuditSink } from "@/contexts/tenancy/application/audit-log";
import { ConflictError, NotFoundError, ValidationError, viaMeta, type Actor } from "@/shared/errors";
import { canArchive, canTransition, stepsEditable, stepsWithPlaceholders, type CampaignStatus, type CampaignStatusChange, type StepIssue } from "../domain/campaign";
import { enrollUnder, type EnrollOptions } from "./enroll-options";
import { MAX_PICKED_IDS, adminStore, assertAssignedSendersConnected, removeCampaignEnrollment, removeCampaignEnrollments, validateSenderIds, type EnrollmentAdminStore, type OutreachChannel, type PickedEnrollCounts, type RemoveCounts, type SenderRef } from "./enrollment-admin";
import { findUnknownFields, unknownFieldsProblem, type MergeFieldSource } from "./merge-fields";

/*
 * The rules a campaign's life follows on either channel. `campaign-management.ts` and `linkedin-campaigns.ts` bind them to
 * their stores and add what differs: email samples first subjects before a launch, and a LinkedIn campaign has a type.
 */

/** Most people one enroll by query may add. */
export const MAX_ENROLL_BATCH = 5000;

interface CampaignStep {
  stepNumber: number;
  subject?: string;
  body: string;
}

interface CampaignRow<Step> {
  name: string;
  status: CampaignStatus;
  steps: Step[];
  archivedAt: Date | null;
}

/** The store methods both channels answer the same way. `Enrolled` is what an enroll by query counts. */
export interface CampaignLifecycleStore<Step, Row extends CampaignRow<Step> = CampaignRow<Step>, Enrolled = unknown> {
  transaction<T>(fn: (tx: DbHandle) => Promise<T>, within?: DbHandle): Promise<T>;
  get(organizationId: string, id: string, tx?: DbHandle): Promise<Row | null>;
  create(organizationId: string, input: { name: string; createdBy: string; steps: Step[] }, tx?: DbHandle): Promise<string>;
  furthestStep(organizationId: string, id: string, tx?: DbHandle): Promise<number>;
  update(organizationId: string, id: string, patch: { name?: string; steps?: Step[] }, tx?: DbHandle): Promise<boolean>;
  setStatus(organizationId: string, id: string, change: CampaignStatusChange<Step>, tx?: DbHandle): Promise<boolean>;
  delete(organizationId: string, id: string): Promise<boolean>;
  setArchived(organizationId: string, id: string, archived: boolean): Promise<boolean>;
  enroll(organizationId: string, id: string, filter: { query?: string; limit: number; collectIds?: boolean; dryRun?: boolean; viaTokenId?: string | null }, tx?: DbHandle): Promise<Enrolled>;
}

export interface CampaignLifecycleDeps<Step, Row extends CampaignRow<Step> = CampaignRow<Step>, Enrolled = unknown> {
  campaigns: CampaignLifecycleStore<Step, Row, Enrolled>;
  fields: MergeFieldSource;
  audit: AuditSink;
  admin?: EnrollmentAdminStore;
  now?: () => Date;
}

/** What a channel adds to the shared rules. */
export interface CampaignChannel<Step> {
  channel: OutreachChannel;
  validateSteps(steps: Step[]): StepIssue[];
  /** The refusal when an edit would leave fewer steps than a lead already reached. */
  tooFewSteps(furthest: number): string;
  countConnectedSenders(organizationId: string, tx?: DbHandle): Promise<number>;
  noConnectedSender: string;
}

const cleanName = (name: string) => {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 120) throw new ValidationError("Give the campaign a name of up to 120 characters.");
  return trimmed;
};

export async function loadCampaign<Row>(campaigns: { get(organizationId: string, id: string, tx?: DbHandle): Promise<Row | null> }, actor: Actor, id: string, tx?: DbHandle): Promise<Row> {
  const campaign = await campaigns.get(actor.organizationId, id, tx);
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign;
}

/** `row` turns the clean name into what the store writes. */
export async function createCampaignOn<Step, Row extends CampaignRow<Step>, Enrolled, Input extends { name: string; createdBy: string; steps: Step[] }>(
  deps: CampaignLifecycleDeps<Step, Row, Enrolled>,
  channel: CampaignChannel<Step>,
  actor: Actor,
  input: { name: string; senderIds?: string[] },
  row: (name: string) => Input,
  tx?: DbHandle,
): Promise<{ id: string }> {
  const written = row(cleanName(input.name));
  const senderIds = await validateSenderIds(adminStore(deps), actor, channel.channel, input.senderIds ?? []);
  // One transaction: a campaign that fails to take its senders must not exist, or it would send from every sender.
  const id = await deps.campaigns.transaction(async (t) => {
    const created = await deps.campaigns.create(actor.organizationId, written, t);
    if (senderIds.length > 0) await adminStore(deps).replaceSenders(actor.organizationId, created, channel.channel, senderIds, t);
    return created;
  }, tx);
  return { id };
}

/**
 * With `tx`, the edit joins the caller's transaction and reads through it: an agent's edit holds the campaign row there, and
 * a read from the pool could wait on a connection this request holds. `more` adds the channel's own columns to the patch.
 */
export async function updateCampaignOn<Step, Row extends CampaignRow<Step>, Enrolled>(
  deps: CampaignLifecycleDeps<Step, Row, Enrolled>,
  channel: CampaignChannel<Step>,
  actor: Actor,
  id: string,
  patch: { name?: string; steps?: Step[]; senderIds?: string[] },
  tx?: DbHandle,
  more?: (campaign: Row) => Promise<Record<string, unknown>>,
): Promise<void> {
  const campaign = await loadCampaign(deps.campaigns, actor, id, tx);
  const next: { name?: string; steps?: Step[] } = {};
  const senderIds = patch.senderIds === undefined ? undefined : await validateSenderIds(adminStore(deps), actor, channel.channel, patch.senderIds, tx);
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (more) Object.assign(next, await more(campaign));
  if (patch.steps !== undefined) {
    if (!stepsEditable(campaign.status)) throw new ConflictError("Pause the campaign before editing its steps.");
    const issues = channel.validateSteps(patch.steps);
    if (issues.length > 0) throw new ValidationError("Fix the steps and save again.", issues);
    const furthest = await deps.campaigns.furthestStep(actor.organizationId, id, tx);
    if (patch.steps.length < furthest) throw new ConflictError(channel.tooFewSteps(furthest));
    next.steps = patch.steps;
  }
  // One transaction: a failed sender replacement must not leave the new name or steps behind.
  await deps.campaigns.transaction(async (t) => {
    if (!(await deps.campaigns.update(actor.organizationId, id, next, t))) throw new ConflictError("The campaign started while you were editing. Pause it before editing its steps.");
    if (senderIds !== undefined) await adminStore(deps).replaceSenders(actor.organizationId, id, channel.channel, senderIds, t);
  }, tx);
}

/**
 * What stops a person starting or resuming this campaign now, in the order a start checks it. The status change throws
 * the first; an agent's launch preview lists them all. `channelProblems` adds the channel's own, before the senders.
 */
export async function startProblemsOn<Step extends CampaignStep, Row extends CampaignRow<Step>, Enrolled>(
  deps: CampaignLifecycleDeps<Step, Row, Enrolled>,
  channel: CampaignChannel<Step>,
  actor: Actor,
  id: string,
  campaign: Row,
  tx?: DbHandle,
  channelProblems?: () => Promise<ValidationError[]>,
): Promise<ValidationError[]> {
  const problems: ValidationError[] = [];
  const issues = channel.validateSteps(campaign.steps);
  if (issues.length > 0) problems.push(new ValidationError("Fix the steps before starting.", issues));
  const unfinished = stepsWithPlaceholders(campaign.steps);
  if (unfinished.length > 0) problems.push(new ValidationError(`Replace the [[bracketed text]] in step ${unfinished.join(", ")} before starting.`));
  const unknown = await findUnknownFields(deps.fields, actor.organizationId, campaign.steps, tx);
  if (unknown.length > 0) problems.push(unknownFieldsProblem(unknown));
  if (channelProblems) problems.push(...(await channelProblems()));
  try {
    await assertAssignedSendersConnected(adminStore(deps), actor, channel.channel, id, tx);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problems.push(error);
  }
  if ((await channel.countConnectedSenders(actor.organizationId, tx)) === 0) problems.push(new ValidationError(channel.noConnectedSender));
  return problems;
}

/** With `tx`, the change joins the caller's transaction: an agent's launch holds the campaign row there. */
export async function changeStatusOn<Step, Row extends CampaignRow<Step>, Enrolled>(
  campaigns: CampaignLifecycleStore<Step, Row, Enrolled>,
  actor: Actor,
  id: string,
  to: CampaignStatus,
  startProblems: (campaign: Row) => Promise<ValidationError[]>,
  tx?: DbHandle,
): Promise<void> {
  const campaign = await loadCampaign(campaigns, actor, id, tx);
  if (campaign.archivedAt) throw new ConflictError(`An archived campaign cannot be ${to === "active" ? "started" : "changed"}. Unarchive it first.`);
  if (!canTransition(campaign.status, to)) throw new ConflictError(`A ${campaign.status} campaign cannot become ${to}.`);
  if (to === "active") {
    const [problem] = await startProblems(campaign);
    if (problem) throw problem;
  }
  if (!(await campaigns.setStatus(actor.organizationId, id, { from: campaign.status, to, checkedSteps: campaign.steps, viaTokenId: actor.via?.tokenId ?? null }, tx))) {
    throw new ConflictError("The campaign changed while you were saving. Reload it and try again.");
  }
}

/** Hides a completed campaign from the default list. Its sends, enrollments and analytics stay. */
export async function archiveOn<Step, Row extends CampaignRow<Step>, Enrolled>(campaigns: CampaignLifecycleStore<Step, Row, Enrolled>, actor: Actor, id: string): Promise<void> {
  const campaign = await loadCampaign(campaigns, actor, id);
  if (campaign.archivedAt) return;
  if (!canArchive(campaign.status)) throw new ConflictError("Only a completed campaign can be archived. Mark it completed first.");
  if (!(await campaigns.setArchived(actor.organizationId, id, true))) throw new ConflictError("The campaign changed. Reload and try again.");
}

export async function unarchiveOn<Step, Row extends CampaignRow<Step>, Enrolled>(campaigns: CampaignLifecycleStore<Step, Row, Enrolled>, actor: Actor, id: string): Promise<void> {
  const campaign = await loadCampaign(campaigns, actor, id);
  if (!campaign.archivedAt) return;
  await campaigns.setArchived(actor.organizationId, id, false);
}

export async function deleteOn<Step, Row extends CampaignRow<Step>, Enrolled>(deps: CampaignLifecycleDeps<Step, Row, Enrolled>, channel: OutreachChannel, actor: Actor, id: string): Promise<void> {
  const campaign = await loadCampaign(deps.campaigns, actor, id);
  // The code an agent's preview answers for the same refusal.
  const refusal = () => new ConflictError("Only a draft campaign can be deleted. Pause it or mark it completed instead.", { code: "campaign_not_draft" });
  if (campaign.status !== "draft") throw refusal();
  // The store deletes a draft only, so a start between the read and the write leaves the campaign and no audit row.
  if (!(await deps.campaigns.delete(actor.organizationId, id))) throw refusal();
  await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "campaign.deleted", entityType: "campaign", entityId: id, meta: { name: campaign.name, channel, ...viaMeta(actor.via) } });
}

export async function enrollOn<Step, Row extends CampaignRow<Step>, Enrolled>(
  campaigns: CampaignLifecycleStore<Step, Row, Enrolled>,
  actor: Actor,
  id: string,
  input: { query?: string; limit?: number; collectIds?: boolean; dryRun?: boolean },
  options: EnrollOptions = {},
  tx?: DbHandle,
): Promise<Enrolled> {
  const campaign = await loadCampaign(campaigns, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? MAX_ENROLL_BATCH)), MAX_ENROLL_BATCH);
  return enrollUnder(campaigns, async (t) => (await loadCampaign(campaigns, actor, id, t)).status, options, tx, (t) =>
    campaigns.enroll(actor.organizationId, id, { query: input.query?.trim() || undefined, limit, collectIds: input.collectIds, dryRun: input.dryRun, viaTokenId: actor.via?.tokenId ?? null }, t),
  );
}

/** Enrolls the people a person ticked. Ids of another organization count as not found. */
export async function enrollPickedOn<Step, Row extends CampaignRow<Step>, Enrolled>(
  deps: CampaignLifecycleDeps<Step, Row, Enrolled>,
  channel: OutreachChannel,
  actor: Actor,
  id: string,
  personIds: string[],
  options: EnrollOptions = {},
  tx?: DbHandle,
): Promise<PickedEnrollCounts> {
  const campaign = await loadCampaign(deps.campaigns, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  if (personIds.length === 0) throw new ValidationError("Pick at least one lead.");
  if (personIds.length > MAX_PICKED_IDS) throw new ValidationError(`Add up to ${MAX_PICKED_IDS} leads at a time.`);
  return enrollUnder(deps.campaigns, async (t) => (await loadCampaign(deps.campaigns, actor, id, t)).status, options, tx, (t) =>
    adminStore(deps).enrollPicked(actor.organizationId, id, channel, personIds, actor.via?.tokenId ?? null, t),
  );
}

/** Takes leads out of a campaign. The enrollment keeps its history and the person stays in Leads. */
export async function removeLeadsOn<Step, Row extends CampaignRow<Step>, Enrolled>(deps: CampaignLifecycleDeps<Step, Row, Enrolled>, channel: OutreachChannel, actor: Actor, id: string, enrollmentIds: string[]): Promise<RemoveCounts> {
  await loadCampaign(deps.campaigns, actor, id);
  return removeCampaignEnrollments(deps, actor, channel, id, enrollmentIds);
}

export async function removeLeadOn<Step, Row extends CampaignRow<Step>, Enrolled>(deps: CampaignLifecycleDeps<Step, Row, Enrolled>, channel: OutreachChannel, actor: Actor, id: string, enrollmentId: string): Promise<{ removed: boolean; skippedFinal: boolean }> {
  await loadCampaign(deps.campaigns, actor, id);
  return removeCampaignEnrollment(deps, actor, channel, id, enrollmentId);
}

/** The campaign's assigned senders and every sender of the organization, for the picker. */
export async function sendersOn<Step, Row extends CampaignRow<Step>, Enrolled>(deps: CampaignLifecycleDeps<Step, Row, Enrolled>, channel: OutreachChannel, actor: Actor, id: string): Promise<{ assigned: SenderRef[]; available: SenderRef[] }> {
  await loadCampaign(deps.campaigns, actor, id);
  const [assigned, available] = await Promise.all([adminStore(deps).listSenders(actor.organizationId, id, channel), adminStore(deps).listAvailableSenders(actor.organizationId, channel)]);
  return { assigned, available };
}
