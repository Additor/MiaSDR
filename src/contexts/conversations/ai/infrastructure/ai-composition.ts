import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mailboxProvider } from "@/contexts/outreach/infrastructure/composition";
import { linkedinGateways } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { aiFakeMode, languageModels } from "@/contexts/ai/infrastructure/composition";
import { env } from "@/shared/env";
import type { Job } from "@/platform/jobs/types";
import { auditSink } from "@/platform/db/audit";
import type { AiJobOpsDeps } from "../application/ai-job-ops";
import { AI_JOB_LEASE_MS, createAiJobs } from "../application/ai-jobs";
import type { ReplyAi, ReplyAiResolver } from "../application/ai-ports";
import { reconcileLinkedInReplies, type LinkedInReplyDeps } from "../../application/linkedin-reply";
import { reconcileReplies, type ReplyDeps } from "../../application/reply-management";
import { drizzleAiJobStore } from "./drizzle-ai-job-store";
import { drizzleLinkedInReplyStore } from "../../infrastructure/drizzle-linkedin-reply-store";
import { drizzleReplyStore } from "../../infrastructure/drizzle-reply-store";
import { FakeReplyAi } from "./fake-reply-ai";
import { createReplyAi } from "./reply-ai";
import { createLinkedInReplySender } from "../../infrastructure/linkedin-reply-sender";
import { createReplyMailer } from "../../infrastructure/reply-mailer";

const globalForAi = globalThis as unknown as { __miasdrFakeAi?: FakeReplyAi };

/**
 * AI_PROVIDER=fake (demos and tests) answers for every organization with the keyword classifier and template drafts.
 * Otherwise the organization's configured language model runs the prompts; no model means null: AI is not configured.
 */
export const replyAiResolver: ReplyAiResolver = {
  async forOrganization(organizationId): Promise<ReplyAi | null> {
    if (aiFakeMode()) return (globalForAi.__miasdrFakeAi ??= new FakeReplyAi());
    const model = await languageModels.forOrganization(organizationId);
    return model ? createReplyAi(model) : null;
  },
  status: (organizationId) => languageModels.status(organizationId),
};

export const replyDeps = (): ReplyDeps => ({
  store: drizzleReplyStore,
  ai: replyAiResolver,
  mailer: createReplyMailer(mailboxProvider),
  now: () => new Date(),
  newToken: () => randomUUID(),
});

export const aiJobOpsDeps = (): AiJobOpsDeps => ({ jobs: drizzleAiJobStore, audit: auditSink, now: () => new Date() });

export const linkedinReplyDeps = (): LinkedInReplyDeps => ({
  store: drizzleLinkedInReplyStore,
  sender: createLinkedInReplySender(linkedinGateways()),
  now: () => new Date(),
  aiStatus: (organizationId) => replyAiResolver.status(organizationId),
});

/** Registered once in the kernel registry. Always on: an organization without a key just sees `not_configured` in the tick report. */
export function conversationJobs(): Job[] {
  const deps = {
    jobs: drizzleAiJobStore,
    replies: drizzleReplyStore,
    ai: replyAiResolver,
    now: () => new Date(),
    workerId: `${hostname()}:${process.pid}`,
    leaseMs: AI_JOB_LEASE_MS,
    notConfiguredDelayMs: 5 * 60_000,
    audit: auditSink,
  };
  const jobs = createAiJobs(deps);
  // Reconciling needs the mailbox, so it exists only when a mail adapter is selected. It looks, it never sends.
  if (env().MAILBOX_PROVIDER) {
    jobs.push({
      name: "conversations.reply-reconcile",
      async run() {
        const report = await reconcileReplies(replyDeps());
        return { processed: report.found, more: report.checked >= 25, detail: { checked: report.checked, uncertain: report.uncertain, waiting: report.waiting } };
      },
    });
  }
  // Looks in LinkedIn chats for replies with no recorded outcome. It never sends. Idle without a LinkedIn connection.
  jobs.push({
    name: "conversations.linkedin-reply-reconcile",
    async run() {
      const report = await reconcileLinkedInReplies(linkedinReplyDeps());
      return { processed: report.found, more: report.checked >= 25, detail: { checked: report.checked, uncertain: report.uncertain, waiting: report.waiting } };
    },
  });
  return jobs;
}
