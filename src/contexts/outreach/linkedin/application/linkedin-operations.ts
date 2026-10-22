import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, type Actor } from "@/shared/errors";
import { replayLinkedInEvents } from "./linkedin-inbound";
import type { AuditSink } from "./linkedin-management";
import type { LinkedInInboundDeps } from "./linkedin-ports";

export interface JobRunRow {
  id: string;
  job: string;
  slot: string;
  status: string;
  /** Null for instance-wide jobs. */
  organizationId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface WebhookBacklog {
  /** Gave up after the maximum attempts. */
  dead: number;
  /** Failed and waiting for the next automatic attempt. */
  retrying: number;
  /** A person asked for a replay that has not run yet. */
  queued: number;
}

export interface ResetOutcome {
  accounts: number;
  pausesCleared: number;
  searchCountersCleared: number;
}

export interface LinkedInOperationsStore {
  recentRuns(organizationId: string, limit: number): Promise<JobRunRow[]>;
  recentAudit(organizationId: string, actions: string[], limit: number): Promise<AuditRow[]>;
  webhookBacklog(organizationId: string): Promise<WebhookBacklog>;
  /**
   * Puts failed LinkedIn deliveries (retrying or dead) back in line for the replay job: zero attempts, due now, replay count plus one.
   * Rows already queued, in flight, done or dismissed are not touched, so a second call right after the first finds nothing.
   */
  requeueFailedWebhooks(organizationId: string, now: Date, limit: number): Promise<number>;
  /**
   * Clears the pause LinkedIn imposed (`limit_reached_until`) and the search lead counter of every account of the organization.
   * The invitation and message counts come from `sends` and stay: they are the safety limit, not a flag.
   */
  resetDailyCounters(organizationId: string, now: Date): Promise<ResetOutcome>;
  /** Writes a finished `job_runs` row for a manual run, so it shows on the jobs page. */
  recordManualRun(input: { organizationId: string; job: string; now: Date; error: string | null }): Promise<void>;
}

export interface LinkedInOperationsDeps {
  store: LinkedInOperationsStore;
  inbound: LinkedInInboundDeps;
  audit: AuditSink;
  now: () => Date;
}

export const REPLAY_BATCH = 100;
export const OPERATION_ACTIONS = ["linkedin.webhooks_replayed", "linkedin.daily_counters_reset", "linkedin.limits_changed", "linkedin.connect_link_created", "linkedin.reconnect_link_created", "linkedin.account_connected"];

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can run LinkedIn jobs.");
}

export async function getLinkedInJobsOverview(deps: LinkedInOperationsDeps, actor: Actor) {
  requireAdmin(actor);
  const [runs, backlog, audit] = await Promise.all([
    deps.store.recentRuns(actor.organizationId, 50),
    deps.store.webhookBacklog(actor.organizationId),
    deps.store.recentAudit(actor.organizationId, OPERATION_ACTIONS, 20),
  ]);
  return { runs, backlog, audit };
}

/** Only the delivery counts, for the Inbound events page that offers Replay. */
export async function getLinkedInWebhookBacklog(deps: LinkedInOperationsDeps, actor: Actor): Promise<WebhookBacklog> {
  requireAdmin(actor);
  return deps.store.webhookBacklog(actor.organizationId);
}

export interface ReplaySummary {
  requeued: number;
  claimed: number;
  done: number;
  failed: number;
}

/**
 * Replays this organization's failed LinkedIn deliveries now. Handling an event is idempotent (the ledger key is unique and
 * the row keeps its identity), so pressing the button twice never applies an event twice.
 */
export async function replayFailedLinkedInWebhooks(deps: LinkedInOperationsDeps, actor: Actor): Promise<ReplaySummary> {
  requireAdmin(actor);
  const now = deps.now();
  const requeued = await deps.store.requeueFailedWebhooks(actor.organizationId, now, REPLAY_BATCH);
  const report = await replayLinkedInEvents(deps.inbound, REPLAY_BATCH, actor.organizationId);
  const summary: ReplaySummary = { requeued, ...report };
  await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "linkedin.webhooks_replayed", meta: { ...summary } });
  await deps.store.recordManualRun({ organizationId: actor.organizationId, job: "linkedin.replay-webhooks", now, error: summary.failed > 0 ? `${summary.failed} delivery(ies) failed again.` : null });
  return summary;
}

export async function resetLinkedInDailyCounters(deps: LinkedInOperationsDeps, actor: Actor): Promise<ResetOutcome> {
  requireAdmin(actor);
  const now = deps.now();
  const outcome = await deps.store.resetDailyCounters(actor.organizationId, now);
  await deps.audit.record({ organizationId: actor.organizationId, actorUserId: actor.userId, action: "linkedin.daily_counters_reset", meta: { ...outcome } });
  await deps.store.recordManualRun({ organizationId: actor.organizationId, job: "linkedin.reset-daily-counters", now, error: null });
  return outcome;
}
