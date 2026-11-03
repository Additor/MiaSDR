import { hostname } from "node:os";
import type { Job } from "@/platform/jobs/types";
import { createFollowUpJobs, FOLLOW_UP_LEASE_MS } from "../application/follow-up-jobs";
import type { AfterReplyDeps } from "../application/after-reply";
import type { FollowUpDeps } from "../application/follow-ups";
import { replyAiResolver } from "../../ai/infrastructure/ai-composition";
import { drizzleFollowUpEngine } from "./drizzle-follow-up-engine";
import { drizzleAfterReplyStore, drizzleRunStore } from "./drizzle-follow-up-store";
import { drizzleReplyStore } from "../../infrastructure/drizzle-reply-store";

export { campaignIdOfFlow } from "./drizzle-follow-up-store";

/** The per-conversation controls: pause, resume, skip, stop, restart. */
export const followUpDeps = (): FollowUpDeps => ({ runs: drizzleRunStore, now: () => new Date() });

/** The campaign setting Follow-ups after a reply. */
export const afterReplyDeps = (): AfterReplyDeps => ({ flows: drizzleAfterReplyStore, now: () => new Date() });

/** Registered in the kernel registry. Always on: an organization without an AI key sees `not_configured` in the tick report. */
export function followUpJobs(): Job[] {
  return createFollowUpJobs({
    engine: drizzleFollowUpEngine,
    runs: drizzleRunStore,
    replies: drizzleReplyStore,
    ai: replyAiResolver,
    now: () => new Date(),
    workerId: `${hostname()}:${process.pid}`,
    leaseMs: FOLLOW_UP_LEASE_MS,
    notConfiguredDelayMs: 5 * 60_000,
  });
}
