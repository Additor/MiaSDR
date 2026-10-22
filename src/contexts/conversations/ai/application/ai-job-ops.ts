import { aiIsOn } from "@/contexts/integrations/domain/ai-status";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { REQUEUE_BATCH } from "../domain/ai-job-requeue";
import type { ReplyAiResolver } from "./ai-ports";
import type { AiJobStore, FailedAiJob, SkippedAiJob } from "../../application/reply-ports";

/** Same shape as the audit sink other contexts use; each composition root passes the `audit_log` writer. */
export interface AuditPort {
  record(entry: { organizationId: string; actorUserId: string | null; action: string; entityType?: string; entityId?: string; meta?: Record<string, unknown> }): Promise<void>;
}

export interface AiJobOpsDeps {
  jobs: AiJobStore;
  audit: AuditPort;
  now: () => Date;
}

export interface SweepDeps extends AiJobOpsDeps {
  ai: ReplyAiResolver;
}

export const FAILED_LIST_LIMIT = 25;
/** Job ids kept in an audit row. The count is always exact. */
const AUDIT_ID_LIMIT = 50;

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage AI jobs.");
}

export async function getFailedAiJobs(deps: AiJobOpsDeps, actor: Actor): Promise<{ total: number; rows: FailedAiJob[] }> {
  requireAdmin(actor);
  return deps.jobs.listFailed(actor.organizationId, FAILED_LIST_LIMIT);
}

/** Jobs the unknown-sender daily cap set aside, so an admin sees why a reply has no classification or draft. */
export async function getSkippedAiJobs(deps: AiJobOpsDeps, actor: Actor): Promise<{ total: number; rows: SkippedAiJob[] }> {
  requireAdmin(actor);
  return deps.jobs.listSkipped(actor.organizationId, FAILED_LIST_LIMIT);
}

export interface RequeueSummary {
  requeued: number;
  /** More failed jobs matched than one call handles. Call again. */
  more: boolean;
}

async function audited(deps: AiJobOpsDeps, actor: Actor, ids: string[], meta: Record<string, unknown>): Promise<RequeueSummary> {
  if (ids.length > 0) {
    await deps.audit.record({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "ai_jobs.requeued",
      entityType: "ai_job",
      entityId: ids.length === 1 ? ids[0] : undefined,
      meta: { ...meta, count: ids.length, jobIds: ids.slice(0, AUDIT_ID_LIMIT) },
    });
  }
  return { requeued: ids.length, more: ids.length >= REQUEUE_BATCH };
}

/**
 * Puts one failed job, or one the daily cap skipped, back in the queue. Any other job (already requeued, running, done) changes
 * nothing and returns 0, so a double click is safe. Another organization's job is a 404.
 */
export async function requeueAiJob(deps: AiJobOpsDeps, actor: Actor, jobId: string): Promise<RequeueSummary> {
  requireAdmin(actor);
  const ids = await deps.jobs.requeueFailed(actor.organizationId, { jobId }, deps.now(), 1);
  if (ids.length === 0 && !(await deps.jobs.jobExists(actor.organizationId, jobId))) throw new NotFoundError("AI job not found.");
  return audited(deps, actor, ids, { mode: "single" });
}

/** Puts every job of this organization that failed, or was skipped by the daily cap, at or after `since` back in the queue. */
export async function requeueFailedAiJobsSince(deps: AiJobOpsDeps, actor: Actor, since: Date): Promise<RequeueSummary> {
  requireAdmin(actor);
  if (Number.isNaN(since.getTime())) throw new ValidationError("Choose a valid start time.");
  const ids = await deps.jobs.requeueFailed(actor.organizationId, { since }, deps.now(), REQUEUE_BATCH);
  return audited(deps, actor, ids, { mode: "since", since: since.toISOString() });
}

/**
 * Automatic requeue of failed jobs, one organization at a time. The store applies backoff, the failure kind and the
 * per-job ceiling. An organization without an AI key is skipped: its jobs would only be released again, and a
 * requeue would use up ceiling for no attempt. Each organization with requeued jobs gets one audit row.
 */
export async function sweepFailedAiJobs(deps: SweepDeps): Promise<number> {
  const now = deps.now();
  let total = 0;
  for (const organizationId of await deps.jobs.organizationsWithSweepable(now)) {
    if (!aiIsOn(await deps.ai.status(organizationId))) continue;
    const ids = await deps.jobs.requeueSweepable(organizationId, now, REQUEUE_BATCH);
    if (ids.length === 0) continue;
    total += ids.length;
    await deps.audit.record({
      organizationId,
      actorUserId: null,
      action: "ai_jobs.auto_requeued",
      entityType: "ai_job",
      meta: { count: ids.length, jobIds: ids.slice(0, AUDIT_ID_LIMIT) },
    });
  }
  return total;
}
