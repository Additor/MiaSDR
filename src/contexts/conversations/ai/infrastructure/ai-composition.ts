import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import { credentialCipher } from "@/contexts/integrations/infrastructure/credential-cipher";
import { mailboxProvider } from "@/contexts/outreach/infrastructure/composition";
import { linkedinGateways } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { db } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import { env } from "@/shared/env";
import type { Job } from "@/platform/jobs/types";
import { auditSink } from "@/platform/db/audit";
import type { AiJobOpsDeps } from "../application/ai-job-ops";
import { AI_JOB_LEASE_MS, createAiJobs } from "../application/ai-jobs";
import type { AiProvider, AiProviderResolver } from "../application/ai-ports";
import { reconcileLinkedInReplies, type LinkedInReplyDeps } from "../../application/linkedin-reply";
import { reconcileReplies, type ReplyDeps } from "../../application/reply-management";
import { AnthropicAiProvider } from "./anthropic-ai-provider";
import { drizzleAiJobStore } from "./drizzle-ai-job-store";
import { drizzleLinkedInReplyStore } from "../../infrastructure/drizzle-linkedin-reply-store";
import { drizzleReplyStore } from "../../infrastructure/drizzle-reply-store";
import { FakeAiProvider } from "./fake-ai-provider";
import { createLinkedInReplySender } from "../../infrastructure/linkedin-reply-sender";
import { createReplyMailer } from "../../infrastructure/reply-mailer";

const globalForAi = globalThis as unknown as { __miasdrFakeAi?: FakeAiProvider };

/**
 * AI_PROVIDER=fake (demos and tests) answers for every organization. Otherwise the organization's own
 * Anthropic key is read and decrypted for this call only. No stored key means null: AI is not configured.
 */
export const aiResolver: AiProviderResolver = {
  async forOrganization(organizationId): Promise<AiProvider | null> {
    if (env().AI_PROVIDER === "fake") return (globalForAi.__miasdrFakeAi ??= new FakeAiProvider());
    const [row] = await db
      .select({ payload: integrationCredentials.encryptedPayload, config: integrationAccounts.config })
      .from(integrationAccounts)
      .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.key, "anthropic"), eq(integrationAccounts.enabled, true)));
    if (!row) return null;
    try {
      const { apiKey } = JSON.parse(credentialCipher.decrypt(row.payload)) as { apiKey?: string };
      if (!apiKey) return null;
      const configured = typeof row.config?.model === "string" ? row.config.model : undefined;
      return new AnthropicAiProvider({ apiKey, model: configured || env().AI_MODEL });
    } catch {
      console.error("The stored Anthropic credential could not be read. Save the key again in Settings, Integrations.");
      return null;
    }
  },
};

export const replyDeps = (): ReplyDeps => ({
  store: drizzleReplyStore,
  ai: aiResolver,
  mailer: createReplyMailer(mailboxProvider),
  now: () => new Date(),
  newToken: () => randomUUID(),
});

export const aiJobOpsDeps = (): AiJobOpsDeps => ({ jobs: drizzleAiJobStore, audit: auditSink, now: () => new Date() });

export const linkedinReplyDeps = (): LinkedInReplyDeps => ({
  store: drizzleLinkedInReplyStore,
  sender: createLinkedInReplySender(linkedinGateways()),
  now: () => new Date(),
  aiConfigured: async (organizationId) => (await aiResolver.forOrganization(organizationId)) !== null,
});

/** Registered once in the kernel registry. Always on: an organization without a key just sees `not_configured` in the tick report. */
export function conversationJobs(): Job[] {
  const deps = {
    jobs: drizzleAiJobStore,
    replies: drizzleReplyStore,
    ai: aiResolver,
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
