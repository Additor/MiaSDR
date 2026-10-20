import { inTransaction, type DbHandle } from "@/platform/db/client";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { canArchive, canTransition, emptyFirstSubjectMessage, type ArchiveFilter, stepsEditable, stepsWithPlaceholders, validateSteps, type CampaignStatus, type StepInput } from "../domain/campaign";
import type { EnrollmentListQuery } from "../domain/enrollment-list";
import { MAX_PICKED_IDS, adminStore, assertAssignedSendersConnected, removeCampaignEnrollment, removeCampaignEnrollments, validateSenderIds, type EnrollmentAdminStore, type PickedEnrollCounts, type RemoveCounts, type SenderRef } from "./enrollment-admin";
import { renderEmail } from "../domain/render";
import { sampleVariables, unresolvedTokens } from "../domain/variables";
import type { CampaignRecord, CampaignStore, EnrollResult, MailboxStore } from "./management-ports";

export interface CampaignDeps {
  campaigns: CampaignStore;
  mailboxes: MailboxStore;
  /** Set by composition. Hand-picked enroll, removal and senders need it. */
  admin?: EnrollmentAdminStore;
  /** Defaults to the system clock. */
  now?: () => Date;
}

/** A send still `unknown` after this long needs a person (the reconciler gave up on proving it either way). */
export const UNCONFIRMED_AFTER_MINUTES = 30;
export const UNCONFIRMED_LIST_LIMIT = 100;

export const DEFAULT_STEPS: StepInput[] = [
  {
    stepNumber: 1,
    kind: "email",
    subject: "Quick question, {{firstName}}",
    body: "Hi {{firstName}},\n\nI work with teams like {{company}} on [[what you help them with]]. Would a short call next week make sense?\n\n%signature%",
    waitDays: 0,
  },
  { stepNumber: 2, kind: "email", subject: "", body: "Hi {{firstName}}, following up on my note below. Worth a quick chat?\n\n%signature%", waitDays: 3 },
];

const cleanName = (name: string) => {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 120) throw new ValidationError("Give the campaign a name of up to 120 characters.");
  return trimmed;
};

async function load(deps: CampaignDeps, actor: Actor, id: string, tx?: DbHandle): Promise<CampaignRecord> {
  const campaign = await deps.campaigns.get(actor.organizationId, id, tx);
  if (!campaign) throw new NotFoundError("Campaign not found");
  return campaign;
}

export function listCampaigns(deps: CampaignDeps, actor: Actor, archived: ArchiveFilter = "hide") {
  return deps.campaigns.list(actor.organizationId, deps.now?.() ?? new Date(), archived);
}

export async function createCampaign(deps: CampaignDeps, actor: Actor, input: { name: string; senderIds?: string[] }, tx?: DbHandle): Promise<{ id: string }> {
  const name = cleanName(input.name);
  const senderIds = await validateSenderIds(adminStore(deps), actor, "email", input.senderIds ?? []);
  // One transaction: a campaign that fails to take its senders must not exist, or it would send from every mailbox.
  const id = await inTransaction(tx, async (t) => {
    const created = await deps.campaigns.create(actor.organizationId, { name, createdBy: actor.userId, steps: DEFAULT_STEPS }, t);
    if (senderIds.length > 0) await adminStore(deps).replaceSenders(actor.organizationId, created, "email", senderIds, t);
    return created;
  });
  return { id };
}

export async function updateCampaign(deps: CampaignDeps, actor: Actor, id: string, patch: { name?: string; steps?: StepInput[]; senderIds?: string[] }): Promise<void> {
  const campaign = await load(deps, actor, id);
  const next: { name?: string; steps?: StepInput[] } = {};
  const senderIds = patch.senderIds === undefined ? undefined : await validateSenderIds(adminStore(deps), actor, "email", patch.senderIds);
  if (patch.name !== undefined) next.name = cleanName(patch.name);

  if (patch.steps !== undefined) {
    if (!stepsEditable(campaign.status)) throw new ConflictError("Pause the campaign before editing its steps.");
    const issues = validateSteps(patch.steps);
    if (issues.length > 0) throw new ValidationError("Fix the steps and save again.", issues);
    const furthest = await deps.campaigns.furthestStep(actor.organizationId, id);
    if (patch.steps.length < furthest) {
      throw new ConflictError(`Some leads already received step ${furthest}. The sequence cannot have fewer than ${furthest} steps.`);
    }
    next.steps = patch.steps;
  }
  // One transaction: a failed sender replacement must not leave the new name or steps behind.
  await inTransaction(undefined, async (tx) => {
    await deps.campaigns.update(actor.organizationId, id, next, tx);
    if (senderIds !== undefined) await adminStore(deps).replaceSenders(actor.organizationId, id, "email", senderIds, tx);
  });
}

/** Leads checked for an empty first subject when a campaign launches. */
export const SUBJECT_SAMPLE = 20;

/** `emptySubjectLeads` of the `sampled` leads render an empty subject and will be skipped at send time. */
export async function changeCampaignStatus(deps: CampaignDeps, actor: Actor, id: string, to: CampaignStatus): Promise<{ emptySubjectLeads: number; sampled: number }> {
  let emptySubjectLeads = 0;
  let sampled = 0;
  const campaign = await load(deps, actor, id);
  if (campaign.archivedAt) throw new ConflictError(`An archived campaign cannot be ${to === "active" ? "started" : "changed"}. Unarchive it first.`);
  if (!canTransition(campaign.status, to)) throw new ConflictError(`A ${campaign.status} campaign cannot become ${to}.`);
  if (to === "active") {
    const issues = validateSteps(campaign.steps);
    if (issues.length > 0) throw new ValidationError("Fix the steps before starting.", issues);
    const unfinished = stepsWithPlaceholders(campaign.steps);
    if (unfinished.length > 0) {
      throw new ValidationError(`Replace the [[bracketed text]] in step ${unfinished.join(", ")} before starting.`);
    }
    // Only the first launch checks the subject. A resume runs the steps the campaign already sent with.
    if (campaign.status === "draft") {
      const leads = await deps.campaigns.liveLeadVariables(actor.organizationId, id, SUBJECT_SAMPLE);
      if (leads.length === 0) {
        const emptySubject = emptyFirstSubjectMessage(campaign.steps, (await deps.campaigns.sampleVariables(actor.organizationId, id)) ?? sampleVariables());
        if (emptySubject) throw new ValidationError(emptySubject, [{ step: 1, message: emptySubject }]);
      } else {
        const empty = leads.filter((variables) => emptyFirstSubjectMessage(campaign.steps, variables) !== null).length;
        // Every sampled lead would send a blank subject, so the subject itself is the problem. A few empty ones are a data gap the send-time check skips.
        if (empty === leads.length) {
          const message = emptyFirstSubjectMessage(campaign.steps, leads[0]) as string;
          throw new ValidationError(message, [{ step: 1, message }]);
        }
        emptySubjectLeads = empty;
        sampled = leads.length;
      }
    }
    await assertAssignedSendersConnected(adminStore(deps), actor, "email", id);
    if ((await deps.mailboxes.countConnected(actor.organizationId)) === 0) {
      throw new ValidationError("Connect a mailbox in Settings before starting a campaign.");
    }
  }
  await deps.campaigns.setStatus(actor.organizationId, id, to);
  return { emptySubjectLeads, sampled };
}

/** Hides a completed campaign from the default list. Its sends, enrollments and analytics stay. */
export async function archiveCampaign(deps: CampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (campaign.archivedAt) return;
  if (!canArchive(campaign.status)) throw new ConflictError("Only a completed campaign can be archived. Mark it completed first.");
  if (!(await deps.campaigns.setArchived(actor.organizationId, id, true))) throw new ConflictError("The campaign changed. Reload and try again.");
}

export async function unarchiveCampaign(deps: CampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (!campaign.archivedAt) return;
  await deps.campaigns.setArchived(actor.organizationId, id, false);
}

export async function deleteCampaign(deps: CampaignDeps, actor: Actor, id: string): Promise<void> {
  const campaign = await load(deps, actor, id);
  if (campaign.status !== "draft") throw new ConflictError("Only a draft campaign can be deleted. Pause it or mark it completed instead.");
  await deps.campaigns.delete(actor.organizationId, id);
}

export const MAX_ENROLL_BATCH = 5000;

export async function enrollLeads(deps: CampaignDeps, actor: Actor, id: string, input: { query?: string; limit?: number; dryRun?: boolean }, tx?: DbHandle): Promise<EnrollResult> {
  const campaign = await load(deps, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? MAX_ENROLL_BATCH)), MAX_ENROLL_BATCH);
  return deps.campaigns.enroll(actor.organizationId, id, { query: input.query?.trim() || undefined, limit, dryRun: input.dryRun }, tx);
}

/** Renders one step the way it would go out, with a real lead from the campaign when there is one. */
export async function previewStep(deps: CampaignDeps, actor: Actor, id: string, stepNumber: number, draftSteps?: StepInput[]) {
  const campaign = await load(deps, actor, id);
  const steps = draftSteps ?? campaign.steps;
  const step = steps[stepNumber - 1];
  if (!step) throw new NotFoundError("Step not found");

  const real = await deps.campaigns.sampleVariables(actor.organizationId, id);
  const variables = real ?? sampleVariables();
  const rendered = renderEmail({
    subjectTemplate: step.subject ?? "",
    bodyTemplate: step.body,
    variables,
    signatureHtml: await deps.mailboxes.firstConnectedSignature(actor.organizationId),
    unsubscribeUrl: "https://your-instance.example/unsubscribe?token=…",
    random: () => 0,
  });
  return {
    subject: rendered.subject === "" ? "(reply in the same thread)" : rendered.subject,
    bodyText: rendered.bodyText,
    usedSampleLead: real === null,
    leadName: (real?.fullName ?? real?.firstName ?? null) as string | null,
    unresolved: unresolvedTokens([step.subject ?? "", step.body], variables),
  };
}

export async function getCampaignDetail(deps: CampaignDeps, actor: Actor, id: string, query: EnrollmentListQuery) {
  const campaign = await load(deps, actor, id);
  const now = deps.now?.() ?? new Date();
  const [enrollments, connectedMailboxes, waitingOnUnavailable, unconfirmed] = await Promise.all([
    deps.campaigns.listEnrollments(actor.organizationId, id, { ...query, campaignStatus: campaign.status }),
    deps.mailboxes.countConnected(actor.organizationId),
    deps.campaigns.waitingOnUnavailableMailbox(actor.organizationId, id),
    deps.campaigns.unconfirmedSends(actor.organizationId, id, new Date(now.getTime() - UNCONFIRMED_AFTER_MINUTES * 60_000), UNCONFIRMED_LIST_LIMIT),
  ]);
  return { campaign, enrollments, connectedMailboxes, waitingOnUnavailable, unconfirmed };
}

/** Enrolls the people a person ticked. Ids of another organization count as not found. */
export async function enrollPickedLeads(deps: CampaignDeps, actor: Actor, id: string, personIds: string[], tx?: DbHandle): Promise<PickedEnrollCounts & EnrollResult> {
  const campaign = await load(deps, actor, id, tx);
  if (campaign.status === "completed") throw new ConflictError("This campaign is completed.");
  if (personIds.length === 0) throw new ValidationError("Pick at least one lead.");
  if (personIds.length > MAX_PICKED_IDS) throw new ValidationError(`Add up to ${MAX_PICKED_IDS} leads at a time.`);
  const counts = await adminStore(deps).enrollPicked(actor.organizationId, id, "email", personIds, tx);
  return { ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoEmail: counts.skippedMissingIdentity };
}

/** Takes leads out of an email campaign. The enrollment keeps its history and the person stays in Leads. */
export async function removeLeads(deps: CampaignDeps, actor: Actor, id: string, enrollmentIds: string[]): Promise<RemoveCounts> {
  await load(deps, actor, id);
  return removeCampaignEnrollments(deps, actor, "email", id, enrollmentIds);
}

export async function removeLead(deps: CampaignDeps, actor: Actor, id: string, enrollmentId: string): Promise<{ removed: boolean; skippedFinal: boolean }> {
  await load(deps, actor, id);
  return removeCampaignEnrollment(deps, actor, "email", id, enrollmentId);
}

/** The campaign's assigned mailboxes and every mailbox of the organization, for the sender picker. */
export async function getCampaignSenders(deps: CampaignDeps, actor: Actor, id: string): Promise<{ assigned: SenderRef[]; available: SenderRef[] }> {
  await load(deps, actor, id);
  const [assigned, available] = await Promise.all([adminStore(deps).listSenders(actor.organizationId, id, "email"), adminStore(deps).listAvailableSenders(actor.organizationId, "email")]);
  return { assigned, available };
}
