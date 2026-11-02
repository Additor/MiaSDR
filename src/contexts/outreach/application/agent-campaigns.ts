import type { DbHandle } from "@/platform/db/client";
import type { AuditSink } from "@/contexts/tenancy/application/audit-log";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { UTC_DAY_MS, utcDayStart } from "@/shared/utc-day";
import { agentCampaignRefusal, launchToken, launchTokenMatches, type LaunchPurpose, type LaunchState } from "../domain/agent-campaign";
import { canTransition, type CampaignStatus } from "../domain/campaign";
import { changeLinkedInCampaignStatus, linkedInStartProblems, previewLinkedInStep, type LinkedInCampaignDeps } from "../linkedin/application/linkedin-campaigns";
import { campaignStartProblems, changeCampaignStatus, previewStep, type CampaignDeps } from "./campaign-management";

/**
 * Agents starting and resuming campaigns and enrolling leads (docs/decisions.md, "Agent campaigns"). Each function
 * runs a person's rules through the same use case a person's button calls, then the agent rules: the organization lets
 * agents run campaigns, sending is not paused, a Personal campaign sends only from accounts the token's person owns,
 * the campaign still matches the preview the agent saw, and agents stay under the daily enroll limit.
 */

export type AgentChannel = "email" | "linkedin";

export interface AgentCampaignRow {
  id: string;
  channel: AgentChannel;
  type: string;
  status: CampaignStatus;
  steps: unknown;
  archivedAt: Date | null;
  /** A person paused it; only a person resumes it. */
  personPaused: boolean;
}

export interface AgentSender {
  id: string;
  status: string;
  name: string;
  /** LinkedIn only: the member who owns the account. */
  ownerUserId: string | null;
  /** LinkedIn only: invitations a day. */
  dailyLimit: number | null;
  limitReachedUntil: Date | null;
}

export interface AgentCampaignStore {
  transaction<T>(fn: (tx: DbHandle) => Promise<T>, within?: DbHandle): Promise<T>;
  /** A read-only repeatable-read transaction, so a preview's checks and token come from one moment. */
  snapshot<T>(organizationId: string, campaignId: string, fn: (tx: DbHandle) => Promise<T>): Promise<T>;
  campaign(tx: DbHandle, organizationId: string, campaignId: string): Promise<AgentCampaignRow | null>;
  /** The campaign `FOR UPDATE`, for a start, a resume or an edit. */
  lockForStart(tx: DbHandle, organizationId: string, campaignId: string): Promise<AgentCampaignRow | null>;
  /** The campaign `FOR SHARE`, for an enroll. */
  lockForEnroll(tx: DbHandle, organizationId: string, campaignId: string): Promise<AgentCampaignRow | null>;
  /** Takes `agent-send` shared and reads what the token may do now. */
  gate(tx: DbHandle, organizationId: string, tokenId: string, now: Date): Promise<{ campaigns: boolean; enrollCap: number }>;
  /** The organization's `agent-enroll` lock, exclusive. */
  lockAgentEnroll(tx: DbHandle, organizationId: string): Promise<void>;
  /** The campaign's own senders, or every account of its channel when it names none (`assigned` false). */
  senders(tx: DbHandle, organizationId: string, campaign: AgentCampaignRow): Promise<{ assigned: boolean; senders: AgentSender[] }>;
  /** Enrollments waiting for their first step. */
  pending(tx: DbHandle, campaignId: string): Promise<number>;
  sendPaused(tx: DbHandle, organizationId: string): Promise<boolean>;
  agentEnrolledSince(tx: DbHandle, organizationId: string, since: Date): Promise<number>;
  /** Running campaigns an agent started or resumed last. */
  agentStartedActive(organizationId: string): Promise<Array<{ id: string; channel: AgentChannel }>>;
}

export interface AgentCampaignDeps {
  store: AgentCampaignStore;
  email: CampaignDeps;
  linkedin: LinkedInCampaignDeps;
  audit: AuditSink;
  now: () => Date;
}


function tokenOf(actor: Actor): string {
  if (!actor.via) throw new Error("An agent campaign action needs an agent actor.");
  return actor.via.tokenId;
}

async function find(load: Promise<AgentCampaignRow | null>, channel: AgentChannel): Promise<AgentCampaignRow> {
  const row = await load;
  // Another channel's id answers as an unknown one does.
  if (!row || row.channel !== channel) throw new NotFoundError("Campaign not found");
  return row;
}

const stateOf = (row: AgentCampaignRow, senders: AgentSender[]): LaunchState => ({ channel: row.channel, status: row.status, steps: row.steps, senders: senders.map((s) => ({ id: s.id, status: s.status })) });

/** Why the token's person may not send from this Personal campaign's accounts, or null when they may. */
function ownershipProblem(actor: Actor, row: AgentCampaignRow, senders: { assigned: boolean; senders: AgentSender[] }): string | null {
  if (row.type !== "personal") return null;
  if (!senders.assigned || senders.senders.length === 0) return "agent_sender_not_owned";
  return senders.senders.every((s) => s.ownerUserId === actor.userId) ? null : "agent_sender_not_owned";
}

/** The status a purpose starts from: a start leaves a draft, a resume a paused campaign. */
const FROM: Record<Exclude<LaunchPurpose, "enroll">, CampaignStatus> = { start: "draft", resume: "paused" };

/** A start problem as sentences: each step issue on its own, or the problem's message. */
const sentences = (problem: ValidationError): string[] =>
  problem.issues.length > 0 ? problem.issues.map((i) => (i.step ? `Step ${i.step}: ${i.message}` : i.message)) : [problem.message];

export interface LaunchPreview {
  channel: AgentChannel;
  campaignId: string;
  purpose: LaunchPurpose;
  status: CampaignStatus;
  /** What stops the action now. Empty means the launch or enroll would pass these checks. */
  problems: string[];
  senders: Array<{ id: string; name: string; status: string; dailyInviteLimit: number | null; limitReachedUntil: string | null }>;
  /** The senders are every account of the channel because the campaign names none. */
  allAccounts: boolean;
  pendingLeads: number;
  agentEnrollsLeftToday: number;
  launchToken: string;
  firstStep: { subject: string | null; bodyText: string; leadName: string | null };
  /** Email: sampled leads whose first subject renders empty; they are skipped at send time. */
  emptySubjectLeads: number | null;
  /** LinkedIn: days the waiting leads take at the senders' invitation limits. */
  estimatedDays: number | null;
}

/**
 * What an agent's start, resume or active enroll would do, and the token that proves it saw this state. Reads one
 * snapshot, so the problems and the token describe the same moment. Changes nothing.
 */
export async function previewLaunch(deps: AgentCampaignDeps, actor: Actor, input: { channel: AgentChannel; campaignId: string; purpose: LaunchPurpose }): Promise<LaunchPreview> {
  const tokenId = tokenOf(actor);
  const now = deps.now();
  const read = await deps.store.snapshot(actor.organizationId, input.campaignId, async (tx) => {
    const row = await find(deps.store.campaign(tx, actor.organizationId, input.campaignId), input.channel);
    const senders = await deps.store.senders(tx, actor.organizationId, row);
    const pending = await deps.store.pending(tx, row.id);
    const gate = await deps.store.gate(tx, actor.organizationId, tokenId, now);
    const paused = await deps.store.sendPaused(tx, actor.organizationId);
    const used = await deps.store.agentEnrolledSince(tx, actor.organizationId, utcDayStart(now));
    return { row, senders, pending, gate, paused, used };
  });
  const { row, senders, pending, gate, paused, used } = read;
  const problems: string[] = [];
  const startsNow = input.purpose !== "enroll" || row.status === "active";
  if (row.archivedAt) problems.push("The campaign is archived. A person unarchives it first.");
  if (input.purpose !== "enroll" && row.status !== FROM[input.purpose]) problems.push(`A ${row.status} campaign cannot be ${input.purpose === "start" ? "started" : "resumed"}.`);
  if (input.purpose === "resume" && row.status === "paused" && row.personPaused) problems.push("A person paused this campaign, so only a person resumes it (agent_resume_person_paused).");
  if (input.purpose === "enroll" && row.status === "completed") problems.push("The campaign is completed.");
  if (startsNow && !gate.campaigns) problems.push("Agents may not start campaigns or enroll leads in running ones here (agent_campaigns_off).");
  if (startsNow && paused) problems.push("Sending is paused for this organization (agent_send_paused).");
  if (startsNow && ownershipProblem(actor, row, senders)) problems.push("This Personal campaign sends from accounts the token's person does not own, or names no senders (agent_sender_not_owned).");
  // A start or resume lists the checks the status change runs, so a preview that passes them starts.
  let emptySubjectLeads: number | null = null;
  if (input.purpose !== "enroll") {
    const check = row.channel === "email" ? await campaignStartProblems(deps.email, actor, row.id) : { problems: await linkedInStartProblems(deps.linkedin, actor, row.id), emptySubjectLeads: null };
    problems.push(...check.problems.flatMap(sentences));
    if (row.channel === "email" && input.purpose === "start") emptySubjectLeads = check.emptySubjectLeads;
  } else if (senders.senders.every((s) => s.status !== "connected")) problems.push(row.channel === "email" ? "No mailbox the campaign sends from is connected." : "No LinkedIn account the campaign sends from is connected.");
  else if (senders.assigned && senders.senders.some((s) => s.status !== "connected")) problems.push("A sender the campaign names is not connected. A person reconnects it or removes it from the campaign.");

  const firstStep =
    row.channel === "email"
      ? await previewStep(deps.email, actor, row.id, 1).then((p) => ({ subject: p.subject, bodyText: p.bodyText, leadName: p.leadName })).catch(() => ({ subject: null, bodyText: "", leadName: null }))
      : await previewLinkedInStep(deps.linkedin, actor, row.id, 1).then((p) => ({ subject: null, bodyText: p.text, leadName: p.leadName })).catch(() => ({ subject: null, bodyText: "", leadName: null }));
  const inviteCapacity = senders.senders.filter((s) => s.status === "connected").reduce((sum, s) => sum + (s.dailyLimit ?? 0), 0);
  return {
    channel: row.channel,
    campaignId: row.id,
    purpose: input.purpose,
    status: row.status,
    problems,
    senders: senders.senders.map((s) => ({ id: s.id, name: s.name, status: s.status, dailyInviteLimit: s.dailyLimit, limitReachedUntil: s.limitReachedUntil?.toISOString() ?? null })),
    allAccounts: !senders.assigned,
    pendingLeads: pending,
    agentEnrollsLeftToday: Math.max(0, gate.enrollCap - used),
    launchToken: launchToken(input.purpose, stateOf(row, senders.senders), pending),
    firstStep,
    emptySubjectLeads,
    estimatedDays: row.channel === "linkedin" && inviteCapacity > 0 ? Math.ceil(pending / inviteCapacity) : null,
  };
}

/** The agent rules a start, resume or active enroll meets once the campaign row is locked. */
async function checkAgentRun(deps: AgentCampaignDeps, tx: DbHandle, actor: Actor, row: AgentCampaignRow, purpose: LaunchPurpose, token: string | undefined, gate: { campaigns: boolean }) {
  if (!gate.campaigns) throw agentCampaignRefusal("agent_campaigns_off");
  if (await deps.store.sendPaused(tx, actor.organizationId)) throw agentCampaignRefusal("agent_send_paused");
  const senders = await deps.store.senders(tx, actor.organizationId, row);
  if (ownershipProblem(actor, row, senders)) throw agentCampaignRefusal("agent_sender_not_owned");
  const pending = await deps.store.pending(tx, row.id);
  if (!token || !launchTokenMatches(token, purpose, stateOf(row, senders.senders), pending)) throw agentCampaignRefusal("launch_token_stale");
}

/**
 * An agent starts or resumes a campaign with the token from `previewLaunch`. The campaign row stays locked from the
 * checks through the status change, so a step or sender edit cannot slip in between.
 */
export async function launchCampaign(
  deps: AgentCampaignDeps,
  actor: Actor,
  input: { channel: AgentChannel; campaignId: string; action: "start" | "resume"; launchToken: string },
): Promise<{ status: CampaignStatus; emptySubjectLeads: number | null }> {
  const tokenId = tokenOf(actor);
  return deps.store.transaction(async (tx) => {
    const row = await find(deps.store.lockForStart(tx, actor.organizationId, input.campaignId), input.channel);
    if (row.archivedAt) throw new ConflictError("An archived campaign cannot be started. Unarchive it first.");
    if (row.status !== FROM[input.action] || !canTransition(row.status, "active")) throw new ConflictError(`A ${row.status} campaign cannot be ${input.action === "start" ? "started" : "resumed"}.`);
    if (input.action === "resume" && row.personPaused) throw agentCampaignRefusal("agent_resume_person_paused");
    const gate = await deps.store.gate(tx, actor.organizationId, tokenId, deps.now());
    await checkAgentRun(deps, tx, actor, row, input.action, input.launchToken, gate);
    if (row.channel === "email") {
      const { emptySubjectLeads } = await changeCampaignStatus(deps.email, actor, row.id, "active", tx);
      return { status: "active" as const, emptySubjectLeads };
    }
    await changeLinkedInCampaignStatus(deps.linkedin, actor, row.id, "active", tx);
    return { status: "active" as const, emptySubjectLeads: null };
  });
}

/**
 * Runs an agent's enroll under the agent rules. Every agent enroll counts against the organization's daily limit, in
 * any campaign status; enrolling into a running campaign also needs the campaign policy and an `enroll` launch token.
 * `work` runs the person's enroll use case inside this transaction. A batch that would pass the limit is refused whole.
 */
export async function agentEnroll<T extends { added?: number; wouldAdd?: number }>(
  deps: AgentCampaignDeps,
  actor: Actor,
  input: { channel: AgentChannel; campaignId: string; launchToken?: string; dryRun: boolean },
  work: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  const tokenId = tokenOf(actor);
  const now = deps.now();
  return deps.store.transaction(async (tx) => {
    const row = await find(deps.store.lockForEnroll(tx, actor.organizationId, input.campaignId), input.channel);
    const gate = await deps.store.gate(tx, actor.organizationId, tokenId, now);
    if (row.status === "active") await checkAgentRun(deps, tx, actor, row, "enroll", input.launchToken, gate);
    await deps.store.lockAgentEnroll(tx, actor.organizationId);
    const dayStart = utcDayStart(now);
    const used = await deps.store.agentEnrolledSince(tx, actor.organizationId, dayStart);
    const result = await work(tx);
    // A dry run by query reports `wouldAdd`; a picked dry run reports what it would add as `added`.
    const adding = input.dryRun ? (result.wouldAdd ?? result.added ?? 0) : (result.added ?? 0);
    if (used + adding > gate.enrollCap) {
      throw agentCampaignRefusal("agent_enroll_cap", (dayStart.getTime() + UTC_DAY_MS - now.getTime()) / 1000);
    }
    return result;
  });
}

/**
 * Pauses every running campaign an agent started, for an owner or admin who wants agents' outreach stopped at once.
 * A campaign that moved in the meantime is left as it is. Answers how many it paused, and the audit log records it.
 */
export async function pauseAgentStartedCampaigns(deps: AgentCampaignDeps, actor: Actor): Promise<{ paused: number }> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can pause the campaigns agents started.");
  let paused = 0;
  for (const row of await deps.store.agentStartedActive(actor.organizationId)) {
    try {
      if (row.channel === "email") await changeCampaignStatus(deps.email, actor, row.id, "paused");
      else await changeLinkedInCampaignStatus(deps.linkedin, actor, row.id, "paused");
      paused += 1;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  if (paused > 0) await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "mcp.agent_campaigns_paused", meta: { count: paused } });
  return { paused };
}

/**
 * An agent's edit of a campaign. The row stays locked from the checks through the write, so a start cannot slip in
 * between: an agent changes senders only while the campaign is not running, though a person may at any time. `check`
 * adds what the caller refuses against the saved campaign; `work` runs the person's update use case in this transaction.
 */
export async function agentUpdateCampaign(
  deps: AgentCampaignDeps,
  actor: Actor,
  input: { channel: AgentChannel; campaignId: string; changesSenders: boolean },
  check: (row: AgentCampaignRow) => void,
  work: (tx: DbHandle) => Promise<void>,
): Promise<void> {
  await deps.store.transaction(async (tx) => {
    const row = await find(deps.store.lockForStart(tx, actor.organizationId, input.campaignId), input.channel);
    if (input.changesSenders && row.status === "active") throw agentCampaignRefusal("agent_sender_change_active");
    check(row);
    await work(tx);
  });
}

