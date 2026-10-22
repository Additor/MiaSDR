import { getFailedAiJobs } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { listInboundEvents } from "@/contexts/outreach/application/inbound-review";
import { listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import type { Actor } from "@/shared/errors";
import { recentTickFailures } from "@/platform/jobs/failure-log";

export interface Attention {
  count: number;
  label: string;
}

/**
 * Keyed by settings href. An area is absent when nothing needs attention or the count could not be read. Each failure
 * counts in one area only: a Gmail or LinkedIn delivery that gave up belongs to Inbound events, not to LinkedIn or Jobs.
 */
export type AttentionMap = Record<string, Attention | undefined>;

async function count(read: () => Promise<number>): Promise<number> {
  try {
    return await read();
  } catch {
    return 0;
  }
}

export async function loadSettingsAttention(actor: Actor, isAdmin: boolean): Promise<AttentionMap> {
  const [mailboxes, jobs, inbound] = await Promise.all([
    count(async () => (await listMailboxes(mailboxDeps(), actor)).filter((m) => m.status === "failed").length),
    isAdmin ? count(async () => (await getFailedAiJobs(aiJobOpsDeps(), actor)).total + (await recentTickFailures(20)).length) : 0,
    isAdmin ? count(async () => (await listInboundEvents(inboundReviewDeps(), actor, { state: "open", limit: 1 })).total) : 0,
  ]);
  const entry = (n: number, label: string): Attention | undefined => (n > 0 ? { count: n, label: `${n} ${label}` } : undefined);
  return {
    "/settings/mailboxes": entry(mailboxes, "failed"),
    "/settings/jobs": entry(jobs, "failed"),
    "/settings/inbound-events": entry(inbound, "open"),
  };
}
