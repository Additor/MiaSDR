import { getFailedAiJobs } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { listInboundEvents } from "@/contexts/outreach/application/inbound-review";
import { listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import type { Actor } from "@/shared/errors";
import { formatCount } from "@/shared/format-number";
import { recentTickFailures } from "@/platform/jobs/failure-log";
import { readSchedulerHealth, schedulerProblem } from "@/platform/jobs/heartbeat";
import { pendingMigrations } from "@/platform/db/migration-status";
import { isInstanceOperator } from "@/contexts/identity/infrastructure/signup-facts";

export interface Attention {
  count: number;
  label: string;
}

/**
 * Keyed by settings href. An area is absent when nothing needs attention, and says "Could not check" when the count could not be read. Each failure
 * counts in one area only: a Gmail or LinkedIn delivery that gave up belongs to Inbound events, not to LinkedIn or Jobs.
 */
export type AttentionMap = Record<string, Attention | undefined>;

/** Null when the count could not be read. A failed read must not look like nothing to do. */
async function count(read: () => Promise<number>): Promise<number | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** What the operator alone is told about the install: failed jobs, a scheduler that stopped, migrations not applied. */
export async function loadInstallProblems(): Promise<{ failures: Awaited<ReturnType<typeof recentTickFailures>>; problems: string[] }> {
  const [failures, health, pending] = await Promise.all([recentTickFailures(20), readSchedulerHealth(new Date()), pendingMigrations()]);
  const scheduler = schedulerProblem(health);
  return {
    failures,
    problems: [...(scheduler ? [scheduler] : []), ...(pending ? [`${formatCount(pending)} database migration${pending === 1 ? " has" : "s have"} not been applied. Run pnpm db:migrate, or set RUN_MIGRATIONS=true.`] : [])],
  };
}

export async function loadSettingsAttention(actor: Actor, isAdmin: boolean): Promise<AttentionMap> {
  const [mailboxes, jobs, inbound] = await Promise.all([
    count(async () => (await listMailboxes(mailboxDeps(), actor)).filter((m) => m.status === "failed" || (m.status === "connected" && m.lastError)).length),
    isAdmin ? count(async () => (await getFailedAiJobs(aiJobOpsDeps(), actor)).total + (await isInstanceOperator(actor.userId) ? await loadInstallProblems().then(({ failures, problems }) => failures.length + problems.length) : 0)) : 0,
    isAdmin ? count(async () => (await listInboundEvents(inboundReviewDeps(), actor, { state: "open", limit: 1 })).total) : 0,
  ]);
  const entry = (n: number | null, label: string): Attention | undefined => (n === null ? { count: 1, label: "Could not check" } : n > 0 ? { count: n, label: `${formatCount(n)} ${label}` } : undefined);
  return {
    "/settings/mailboxes": entry(mailboxes, "failed"),
    "/settings/jobs": entry(jobs, "failed"),
    "/settings/inbound-events": entry(inbound, "open"),
  };
}
