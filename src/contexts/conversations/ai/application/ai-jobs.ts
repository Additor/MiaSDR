import type { Job } from "@/platform/jobs/types";
import { classificationSchema, draftSchema, linkedinDraftSchema } from "../domain/ai-contract";
import { decideApplication } from "../../domain/classification-policy";
import { needsReply } from "../../domain/reply-policy";
import { normalizeSubject } from "../../domain/subject";
import { detectsStopRequest } from "../../domain/stop-request";
import { DO_NOT_CONTACT_KEY } from "../../domain/classification-policy";
import { AiError } from "@/contexts/ai/domain/ai-error";
import type { ReplyAi, ReplyAiResolver } from "./ai-ports";
import type { AiJobStore, ClaimedJob, DraftContext, ReplyStore } from "../../application/reply-ports";
import { sweepFailedAiJobs, type AuditPort } from "./ai-job-ops";
import type { FailureKind } from "../domain/ai-job-requeue";

export interface AiJobDeps {
  jobs: AiJobStore;
  replies: ReplyStore;
  ai: ReplyAiResolver;
  now: () => Date;
  workerId: string;
  /** A running job whose lease is older than this is taken over. */
  leaseMs: number;
  /** Delay before a job of an organization without AI is looked at again. */
  notConfiguredDelayMs: number;
  /** Writes `audit_log` rows. Without it the sweep that requeues failed jobs does not run. */
  audit?: AuditPort;
}

export const AI_JOB_LEASE_MS = 5 * 60_000;
const retryDelayMs = (attempts: number) => Math.min(5 * 60_000, 2000 * 2 ** Math.max(0, attempts - 1));

function failureKindOf(error: unknown): FailureKind {
  if (!(error instanceof AiError)) return "transient";
  if (error.kind === "permanent") return "permanent";
  return error.reason === "shape" ? "shape" : "transient";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/** Shared by the draft job, `requestDraft` and `regenerateDraft`: asks the provider and validates the answer. */
export async function produceDraft(
  provider: ReplyAi,
  ctx: DraftContext,
  options: { feedback?: string | null; previousDraft?: string | null } = {},
): Promise<{ output: { subject: string | null; bodyText: string }; usage?: Record<string, number> }> {
  const result = await provider.draft({
    channel: ctx.channel,
    person: ctx.person,
    thread: ctx.thread,
    subject: ctx.subject,
    // A stage move after the last reply outdates the classifier's reading of that reply.
    classification: ctx.classification ? { replyTypeName: ctx.classification.replyTypeName, reason: ctx.replyTypeChange ? null : ctx.classification.reason } : null,
    replyTypeChange: ctx.replyTypeChange,
    operatorInstructions: ctx.operatorInstructions,
    knowledge: ctx.knowledge.map((k) => ({ title: k.title, content: k.content })),
    feedback: options.feedback ?? null,
    previousDraft: options.previousDraft ?? null,
    senderName: ctx.senderName,
  });
  if (ctx.channel === "linkedin") {
    // No subject and a hard length limit. The model's subject, if any, is dropped.
    const linkedin = linkedinDraftSchema.safeParse(result.output);
    if (!linkedin.success) throw new AiError("The AI returned a draft in an unexpected shape.", "transient", "shape");
    return { output: { subject: null, bodyText: linkedin.data.bodyText }, usage: result.usage };
  }
  const parsed = draftSchema.safeParse(result.output);
  if (!parsed.success) throw new AiError("The AI returned a draft in an unexpected shape.", "transient", "shape");
  return { output: { subject: normalizeSubject(parsed.data.subject ?? "") || normalizeSubject(ctx.subject), bodyText: parsed.data.bodyText }, usage: result.usage };
}

export function draftCitations(ctx: DraftContext) {
  return ctx.knowledge.map((k) => ({ documentVersionId: k.documentVersionId, excerpt: k.content.slice(0, 400) }));
}

async function classify(deps: AiJobDeps, provider: ReplyAi, job: ClaimedJob): Promise<string> {
  const ctx = await deps.jobs.loadClassifyContext(job.organizationId, job.entityId);
  if (!ctx) return "skipped";
  if (ctx.taxonomy.length === 0) throw new AiError("The reply categories have no active subcategory.", "permanent");
  const keys = ctx.taxonomy.map((t) => t.key);
  const schema = classificationSchema(keys);

  const result = await provider.classify({
    taxonomy: ctx.taxonomy.map(({ key, name, groupKey, description, guidance }) => ({ key, name, groupKey, description, guidance })),
    person: ctx.person,
    thread: ctx.thread,
    operatorInstructions: ctx.operatorInstructions,
    businessContext: ctx.businessContext,
  });
  // The closed set is enforced here, whatever the adapter did: a key outside the pipeline never reaches the record.
  const parsed = schema.safeParse(result.output);
  if (!parsed.success) throw new AiError("The AI answered outside the allowed categories.", "transient", "shape");
  const proposal = ctx.taxonomy.find((t) => t.key === parsed.data.subcategoryKey);
  if (!proposal) throw new AiError("The AI answered outside the allowed categories.", "transient", "shape");

  const decision = decideApplication({
    proposal: { groupKey: proposal.groupKey, replyTypeKey: proposal.key, reviewRequired: proposal.reviewRequired, stageRank: proposal.stageRank, confidence: parsed.data.confidence },
    current: { groupKey: ctx.groupKey, stageRank: ctx.currentStageRank, replyTypeLocked: ctx.replyTypeLocked },
    settings: ctx.settings,
  });
  const stopRequested = detectsStopRequest(ctx.messageText) || proposal.key === DO_NOT_CONTACT_KEY;

  const outcome = await deps.jobs.finishClassification({
    job,
    messageId: job.entityId,
    expectedContextVersion: ctx.contextVersion,
    proposedReplyTypeKey: proposal.key,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason,
    stopRequested,
    decision,
    wantsDraft: needsReply(proposal.groupKey, proposal.key) && !stopRequested,
    provider: provider.name,
    model: provider.model,
    request: { messageId: job.entityId, contextVersion: ctx.contextVersion, allowedKeys: keys },
    response: { output: parsed.data, usage: result.usage ?? null },
  });
  return outcome.status;
}

async function draft(deps: AiJobDeps, provider: ReplyAi, job: ClaimedJob): Promise<string> {
  const ctx = await deps.jobs.loadDraftContext(job.organizationId, job.entityId);
  if (!ctx) return "skipped";
  if (ctx.skip) return ctx.skip;
  const result = await produceDraft(provider, ctx);
  await deps.replies.insertDraft({
    organizationId: ctx.organizationId,
    recordId: ctx.recordId,
    conversationId: ctx.conversationId,
    replyForMessageId: ctx.replyForMessageId,
    expectedContextVersion: ctx.contextVersion,
    channel: ctx.channel,
    subject: result.output.subject,
    bodyText: result.output.bodyText,
    provider: provider.name,
    model: provider.model,
    request: { replyTypePickId: job.entityId, contextVersion: ctx.contextVersion, knowledge: ctx.knowledge.map((k) => k.documentVersionId) },
    response: { usage: result.usage ?? null },
    citations: draftCitations(ctx),
  });
  return "drafted";
}

/**
 * One tick: queue missing classification work, then run jobs until the budget ends. Jobs only write
 * classifications and drafts. Nothing here can send: this file has no mailer.
 */
export function createAiJobs(deps: AiJobDeps): Job[] {
  return [
    {
      name: "conversations.ai",
      async run(ctx) {
        const detail: Record<string, number> = {};
        const count = (key: string) => (detail[key] = (detail[key] ?? 0) + 1);
        // A sweep failure must not stop new work, but the tick report names it so the scheduler logs it.
        if (deps.audit) {
          try {
            const requeued = await sweepFailedAiJobs({ jobs: deps.jobs, ai: deps.ai, audit: deps.audit, now: deps.now });
            if (requeued > 0) detail.auto_requeued = requeued;
          } catch (error) {
            console.error(`[ai-jobs] requeue sweep failed: ${message(error)}`);
            count("sweep_error");
          }
        }
        await deps.jobs.enqueueMissing(deps.now());
        let processed = 0;
        for (const kind of ["classification", "initial_draft"] as const) {
          while (Date.now() < ctx.deadline) {
            const job = await deps.jobs.claim(kind, deps.workerId, deps.now(), deps.leaseMs);
            if (!job) break;
            const provider = await deps.ai.forOrganization(job.organizationId);
            if (!provider) {
              await deps.jobs.release(job, new Date(deps.now().getTime() + deps.notConfiguredDelayMs));
              count("not_configured");
              continue;
            }
            try {
              // After the provider check: a job that waits for a key has not used any of the day's allowance.
              if (job.attempts <= 1 && (await deps.jobs.skipOverCap(job, deps.now()))) {
                count("skipped_daily_cap");
                continue;
              }
              const outcome = kind === "classification" ? await classify(deps, provider, job) : await draft(deps, provider, job);
              await deps.jobs.complete(job, deps.now());
              count(outcome);
              processed += 1;
            } catch (error) {
              const final = (error instanceof AiError && error.kind === "permanent") || job.attempts >= job.maxAttempts;
              if (final) {
                await deps.jobs.fail(job, message(error), deps.now(), failureKindOf(error));
                count("failed");
              } else {
                await deps.jobs.retry(job, message(error), new Date(deps.now().getTime() + retryDelayMs(job.attempts)));
                count("retry");
              }
            }
          }
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
