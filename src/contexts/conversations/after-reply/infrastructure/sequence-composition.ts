import { hostname } from "node:os";
import type { Job } from "@/platform/jobs/types";
import { createSequenceJobs, SEQUENCE_LEASE_MS } from "../application/sequence-jobs";
import type { AfterReplyDeps } from "../application/after-reply";
import type { SequenceDeps } from "../application/sequences";
import { replyAiResolver } from "../../ai/infrastructure/ai-composition";
import { drizzleSequenceEngine } from "./drizzle-sequence-engine";
import { drizzleAfterReplyStore, drizzleRunStore } from "./drizzle-sequence-store";

export { campaignIdOfSequence } from "./drizzle-sequence-store";
import { drizzleReplyStore } from "../../infrastructure/drizzle-reply-store";

/** The per-record controls: pause, resume, skip, stop, restart. */
export const sequenceDeps = (): SequenceDeps => ({ runs: drizzleRunStore, now: () => new Date() });

/** The campaign setting After a reply. */
export const afterReplyDeps = (): AfterReplyDeps => ({ flows: drizzleAfterReplyStore, now: () => new Date() });

/** Registered in the kernel registry. Always on: an organization without an AI key sees `not_configured` in the tick report. */
export function sequenceJobs(): Job[] {
  return createSequenceJobs({
    engine: drizzleSequenceEngine,
    runs: drizzleRunStore,
    replies: drizzleReplyStore,
    ai: replyAiResolver,
    now: () => new Date(),
    workerId: `${hostname()}:${process.pid}`,
    leaseMs: SEQUENCE_LEASE_MS,
    notConfiguredDelayMs: 5 * 60_000,
  });
}
