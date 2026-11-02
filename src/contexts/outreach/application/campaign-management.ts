import type { EnrollOptions } from "./enroll-options";
import type { DbHandle } from "@/platform/db/client";
import type { AuditSink } from "@/contexts/tenancy/application/audit-log";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { emptyFirstSubjectMessage, type ArchiveFilter, validateSteps, type CampaignStatus, type StepInput } from "../domain/campaign";
import { MAX_ENROLL_BATCH, archiveOn, changeStatusOn, createCampaignOn, deleteOn, enrollOn, enrollPickedOn, loadCampaign, removeLeadOn, removeLeadsOn, sendersOn, startProblemsOn, unarchiveOn, updateCampaignOn, type CampaignChannel, type CampaignLifecycleDeps } from "./campaign-lifecycle";
import type { EnrollmentListQuery } from "../domain/enrollment-list";
import type { EnrollmentAdminStore, PickedEnrollCounts, RemoveCounts, SenderRef } from "./enrollment-admin";
import { renderEmail } from "../domain/render";
import { sampleVariables } from "../domain/variables";
import { unresolvedForLead, type MergeFieldSource } from "./merge-fields";
import type { CampaignRecord, CampaignStore, EnrollResult, MailboxStore } from "./management-ports";

export interface CampaignDeps {
  campaigns: CampaignStore;
  mailboxes: MailboxStore;
  fields: MergeFieldSource;
  audit: AuditSink;
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

export { MAX_ENROLL_BATCH };

const lifecycle = (deps: CampaignDeps): CampaignLifecycleDeps<StepInput, CampaignRecord, EnrollResult> => deps;

const email = (deps: CampaignDeps): CampaignChannel<StepInput> => ({
  channel: "email",
  validateSteps,
  tooFewSteps: (furthest) => `Some leads already received step ${furthest}. The sequence cannot have fewer than ${furthest} steps.`,
  countConnectedSenders: (organizationId, tx) => deps.mailboxes.countConnected(organizationId, tx),
  noConnectedSender: "Connect a mailbox in Settings before starting a campaign.",
});

const load = (deps: CampaignDeps, actor: Actor, id: string, tx?: DbHandle): Promise<CampaignRecord> => loadCampaign(deps.campaigns, actor, id, tx);

export function listCampaigns(deps: CampaignDeps, actor: Actor, archived: ArchiveFilter = "hide") {
  return deps.campaigns.list(actor.organizationId, deps.now?.() ?? new Date(), archived);
}

export function createCampaign(deps: CampaignDeps, actor: Actor, input: { name: string; senderIds?: string[] }, tx?: DbHandle): Promise<{ id: string }> {
  return createCampaignOn(lifecycle(deps), email(deps), actor, input, (name) => ({ name, createdBy: actor.userId, steps: DEFAULT_STEPS }), tx);
}

export function updateCampaign(deps: CampaignDeps, actor: Actor, id: string, patch: { name?: string; steps?: StepInput[]; senderIds?: string[] }, tx?: DbHandle): Promise<void> {
  return updateCampaignOn(lifecycle(deps), email(deps), actor, id, patch, tx);
}

/** Leads checked for an empty first subject when a campaign launches. */
export const SUBJECT_SAMPLE = 20;

/** The start problems, with the sampled leads whose first subject renders empty. */
async function startCheck(deps: CampaignDeps, actor: Actor, id: string, campaign: CampaignRecord, tx?: DbHandle): Promise<{ problems: ValidationError[]; emptySubjectLeads: number; sampled: number }> {
  let emptySubjectLeads = 0;
  let sampled = 0;
  const problems = await startProblemsOn(lifecycle(deps), email(deps), actor, id, campaign, tx, async () => {
    // Only the first launch checks the subject. A resume runs the steps the campaign already sent with.
    if (campaign.status !== "draft") return [];
    const leads = await deps.campaigns.liveLeadVariables(actor.organizationId, id, SUBJECT_SAMPLE, tx);
    if (leads.length === 0) {
      const emptySubject = emptyFirstSubjectMessage(campaign.steps, (await deps.campaigns.sampleVariables(actor.organizationId, id, tx)) ?? sampleVariables());
      return emptySubject ? [new ValidationError(emptySubject, [{ step: 1, message: emptySubject }])] : [];
    }
    const empty = leads.filter((variables) => emptyFirstSubjectMessage(campaign.steps, variables) !== null).length;
    // Every sampled lead would send a blank subject, so the subject itself is the problem. A few empty ones are a data gap the send-time check skips.
    if (empty === leads.length) {
      const message = emptyFirstSubjectMessage(campaign.steps, leads[0]) as string;
      return [new ValidationError(message, [{ step: 1, message }])];
    }
    emptySubjectLeads = empty;
    sampled = leads.length;
    return [];
  });
  return { problems, emptySubjectLeads, sampled };
}

/** The start problems of a draft or paused campaign, for a preview. Changes nothing. */
export async function campaignStartProblems(deps: CampaignDeps, actor: Actor, id: string): Promise<{ problems: ValidationError[]; emptySubjectLeads: number }> {
  return startCheck(deps, actor, id, await load(deps, actor, id));
}

/**
 * `emptySubjectLeads` of the `sampled` leads render an empty subject and will be skipped at send time. With `tx`, the
 * change joins the caller's transaction: an agent's launch holds the campaign row there.
 */
export async function changeCampaignStatus(deps: CampaignDeps, actor: Actor, id: string, to: CampaignStatus, tx?: DbHandle): Promise<{ emptySubjectLeads: number; sampled: number }> {
  let emptySubjectLeads = 0;
  let sampled = 0;
  await changeStatusOn(lifecycle(deps).campaigns, actor, id, to, async (campaign) => {
    const check = await startCheck(deps, actor, id, campaign, tx);
    ({ emptySubjectLeads, sampled } = check);
    return check.problems;
  }, tx);
  return { emptySubjectLeads, sampled };
}

export const archiveCampaign = (deps: CampaignDeps, actor: Actor, id: string): Promise<void> => archiveOn(lifecycle(deps).campaigns, actor, id);

export const unarchiveCampaign = (deps: CampaignDeps, actor: Actor, id: string): Promise<void> => unarchiveOn(lifecycle(deps).campaigns, actor, id);

export const deleteCampaign = (deps: CampaignDeps, actor: Actor, id: string): Promise<void> => deleteOn(lifecycle(deps), "email", actor, id);

export function enrollLeads(deps: CampaignDeps, actor: Actor, id: string, input: { query?: string; limit?: number; dryRun?: boolean }, options: EnrollOptions = {}, tx?: DbHandle): Promise<EnrollResult> {
  return enrollOn(lifecycle(deps).campaigns, actor, id, input, options, tx);
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
    unresolved: await unresolvedForLead(deps.fields, actor.organizationId, [step.subject ?? "", step.body], variables),
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

export async function enrollPickedLeads(deps: CampaignDeps, actor: Actor, id: string, personIds: string[], options: EnrollOptions = {}, tx?: DbHandle): Promise<PickedEnrollCounts & EnrollResult> {
  const counts = await enrollPickedOn(lifecycle(deps), "email", actor, id, personIds, options, tx);
  return { ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoEmail: counts.skippedMissingIdentity };
}

export const removeLeads = (deps: CampaignDeps, actor: Actor, id: string, enrollmentIds: string[]): Promise<RemoveCounts> => removeLeadsOn(lifecycle(deps), "email", actor, id, enrollmentIds);

export const removeLead = (deps: CampaignDeps, actor: Actor, id: string, enrollmentId: string): Promise<{ removed: boolean; skippedFinal: boolean }> => removeLeadOn(lifecycle(deps), "email", actor, id, enrollmentId);

export const getCampaignSenders = (deps: CampaignDeps, actor: Actor, id: string): Promise<{ assigned: SenderRef[]; available: SenderRef[] }> => sendersOn(lifecycle(deps), "email", actor, id);
