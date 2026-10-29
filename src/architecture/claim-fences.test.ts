import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { claimMethodsWithoutFence, fencedTableWritesWithoutFence, leaseWritesWithoutToken, sourceOf } from "./claim-fences";

/**
 * Lease queues follow one rule: a worker that lost its claim changes neither the row a later claim holds nor that
 * claim's result. A claim writes a fresh `claim_token`, and every statement that ends or uses the claim filters with
 * `heldBy` (src/platform/db/claim.ts). Three scans hold the rule:
 * (a) a statement that writes a lease status (`running`, `drafting`, `processing`) also writes `claim_token`;
 * (b) a store method that takes a claim (a type with `claimToken`, or one that holds such a type) calls `heldBy`;
 * (c) a statement that updates, deletes or upserts a fenced table (`ai_jobs`, `inbound_events`, `sequence_step_runs`) calls `heldBy`, or
 *     its method sits in FENCE_EXEMPT with the reason it may write without a claim.
 */

const ROOT = path.resolve(__dirname, "../..");
const sources = [...sourceFiles(path.join(ROOT, "src/contexts")), ...sourceFiles(path.join(ROOT, "src/platform"))].map((file) => sourceOf(path.relative(ROOT, file)));

/**
 * Queues that still claim without a token. Shrink-only: a queue leaves this list when its claim writes `claim_token` and
 * its settles filter with `heldBy`.
 */
const NOT_YET_FENCED: Record<string, string> = {
  "src/contexts/grid/enrichment/infrastructure/enrichment-run-store.ts#claim": "Grid enrichment jobs.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-search-store.ts#claimPage": "LinkedIn searches.",
  "src/platform/jobs/slots.ts#claimSlot": "Scheduler job runs (`job_runs`).",
};

/** Methods that update, delete or upsert a fenced table without holding a claim, and why that is right. */
const FENCE_EXEMPT: Record<string, string> = {
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine.ts#claimDue":
    "The expiry sweep before the claim: it fails steps whose lease ran out on the last attempt and clears their token. A worker still on that attempt finds the step no longer drafting, so its settles change nothing.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine.ts#takeDueStep":
    "Takes the claim: it writes the fresh token.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-engine.ts#settleDrafts":
    "Reconcile: it moves `awaiting_review` steps by the fate of their draft. The link that put them there ended the claim and cleared the token.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-store.ts#pause":
    "A person's pause: it moves the run's open steps back to `scheduled`, a drafting one included, and clears the token. The pause ends the claim, so the worker's late settle changes nothing.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-store.ts#resume":
    "A person's resume: it moves the due time of `scheduled` steps, which no claim holds.",
  "src/contexts/conversations/after-reply/infrastructure/drizzle-sequence-store.ts#skipStep":
    "A person's skip: it refuses a `drafting` step, so it skips a step no claim holds.",
  "src/contexts/conversations/after-reply/infrastructure/sequence-run-tx.ts#advanceRunTx":
    "Schedules the step after a settled one. That step is `scheduled` or `failed`, which no claim holds.",
  "src/contexts/conversations/after-reply/infrastructure/sequence-stop.ts#endRunCountingTx":
    "A stop: it cancels the run's open steps, a drafting one included, and clears the token. The stop ends the claim, so the worker's late settle changes nothing.",
  "src/contexts/conversations/ai/infrastructure/drizzle-ai-job-worker-store.ts#claim":
    "Takes the claim: it writes the fresh token. Its first statement is the expiry sweep, which fails jobs whose lease ran out on the last attempt and clears their token.",
  "src/contexts/conversations/ai/infrastructure/drizzle-ai-job-store.ts#requeue":
    "Admin and sweep requeue. It moves failed and skipped rows only, which no claim holds, and clears the token.",
  "src/contexts/conversations/infrastructure/restart-record-work.ts#queuePickDraftTx":
    "A person's pick: it requeues a finished job (token cleared) or marks a running one `rerun` in its payload, which the holder's own settle reads.",
  "src/contexts/conversations/infrastructure/drizzle-reply-handling-store.ts#undoReplyTypePick":
    "Stop on undo: it fails queued draft jobs, which no claim holds, and drops the rerun mark of a running one without ending its claim.",
  "src/contexts/conversations/infrastructure/private-thread-detach.ts#detachPrivateThreadTx":
    "Private-thread detach: it fails queued jobs of the thread, which no claim holds.",
  "src/contexts/conversations/infrastructure/person-purge.ts#purgePersonHandling":
    "Contact purge: it deletes the person's jobs and leaves a running job with a live lease alone.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-inbound-store.ts#claimReplayable":
    "Takes the claim: it writes the fresh token.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-inbound-store.ts#failStoppedAtCap":
    "Expiry sweep: it fails rows whose lease ran out on the last attempt, which no worker holds any more, and clears their token.",
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-operations-store.ts#requeueFailedWebhooks":
    "Admin requeue. It moves failed rows only, which no claim holds, and clears the token.",
  "src/contexts/outreach/email/infrastructure/drizzle-inbound-store.ts#recordMessageGone":
    "Gmail rows of the same table. The mailbox sync writes them under its own mailbox lease; they never take a claim.",
  "src/contexts/outreach/email/infrastructure/drizzle-inbound-store.ts#clearMessageFailure":
    "Gmail rows of the same table. The mailbox sync writes them under its own mailbox lease; they never take a claim.",
  "src/contexts/outreach/email/infrastructure/drizzle-inbound-store.ts#recordMessageFailure":
    "Gmail rows of the same table: the upsert that counts a failed message. The mailbox sync writes them under its own mailbox lease; they never take a claim.",
  "src/contexts/outreach/infrastructure/drizzle-inbound-review-store.ts#requestRetry":
    "Admin retry from the inbound review. It moves dead and dismissed rows only, which no claim holds, and clears the token.",
  "src/contexts/outreach/infrastructure/drizzle-inbound-review-store.ts#dismiss":
    "Admin dismiss from the inbound review. It moves dead, retrying and queued rows only (status failed or pending), which no claim holds.",
  "src/platform/jobs/prune.ts#deleteBatches":
    "Retention prune. Its table comes from `sql.raw`, and it deletes finished rows only: done, skipped and failed inbound events, succeeded AI jobs.",
};

describe("claim fences", () => {
  it("every statement that writes a lease status writes claim_token, except the queues not fenced yet", () => {
    expect(leaseWritesWithoutToken(sources)).toEqual(Object.keys(NOT_YET_FENCED).sort());
  });

  it("every store method that takes a claim calls heldBy", () => {
    const { unfenced, checked } = claimMethodsWithoutFence(sources);
    expect(unfenced).toEqual([]);
    // The scan found the ports it guards. A rename that hides them from it fails here.
    expect(checked).toEqual(
      expect.arrayContaining([
        "AiJobWorkerStore.complete",
        "AiJobWorkerStore.fail",
        "AiJobWorkerStore.retry",
        "AiJobWorkerStore.release",
        "AiJobWorkerStore.skipOverCap",
        "AiJobWorkerStore.finishClassification",
        "AiJobWorkerStore.insertDraft",
        "LinkedInInboundStore.finish",
        "LinkedInInboundStore.fail",
        "SequenceEngineStore.release",
        "SequenceEngineStore.failAttempt",
        "SequenceEngineStore.linkDraft",
      ]),
    );
  });

  it("every update or delete of a fenced table calls heldBy, or has a reason", () => {
    expect(fencedTableWritesWithoutFence(sources)).toEqual(Object.keys(FENCE_EXEMPT).sort());
  });
});

describe("claim fence scans catch a missing fence", () => {
  const ports = sourceOf(
    "fixture/ports.ts",
    `export interface Lease { id: string; attempts: number; claimToken: string }
     export interface Settle { lease: Lease; note: string }
     export interface QueueStore {
       claim(now: Date): Promise<Lease | null>;
       done(lease: Lease, now: Date): Promise<void>;
       settle(input: Settle): Promise<void>;
       list(): Promise<Lease[]>;
     }`,
  );

  it("(a) flags a raw and a Drizzle lease write without claim_token, and passes the ones with it", () => {
    const store = sourceOf(
      "fixture/store.ts",
      `const RUNNING = "running";
       export const store = {
         async rawClaim() { await db.execute(sql\`update queue q set status = 'processing', attempts = q.attempts + 1 where q.id = \${id}\`); },
         async drizzleClaim() { await db.update(queue).set({ status: RUNNING, attempts: 1 }); },
         async insertClaim() { await db.insert(queue).values({ status: "drafting" }); },
         async fencedRaw() { await db.execute(sql\`update queue q set status = 'processing', claim_token = gen_random_uuid() where q.id = \${id}\`); },
         async fencedDrizzle() { await db.update(queue).set({ status: "running", ...TOKEN }); },
         async notLease() { await db.update(queue).set({ status: "failed" }).where(sql\`status = 'running'\`); },
       };
       const TOKEN = { claimToken: null };`,
    );
    expect(leaseWritesWithoutToken([store])).toEqual(["fixture/store.ts#drizzleClaim", "fixture/store.ts#insertClaim", "fixture/store.ts#rawClaim"]);
  });

  it("(b) flags a claim method that skips heldBy, directly or in a claim held by another type", () => {
    const store = sourceOf(
      "fixture/store.ts",
      `const held = (lease: Lease) => and(eq(queue.id, lease.id), heldBy("queue", lease));
       export function createStore(): QueueStore {
         return {
           async claim(now) { return null; },
           async done(lease, now) { await db.update(queue).set({ status: "done" }).where(eq(queue.id, lease.id)); },
           async settle(input) { await db.update(queue).set({ status: "done" }).where(held(input.lease)); },
           async list() { return []; },
         };
       }`,
    );
    expect(claimMethodsWithoutFence([ports, store])).toEqual({ unfenced: ["fixture/store.ts#done"], checked: ["QueueStore.done", "QueueStore.settle"] });
  });

  it("(c) flags an update of a fenced table outside a fenced method", () => {
    const store = sourceOf(
      "fixture/store.ts",
      `export const store = {
         async stop(id: string) { await db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.id, id)); },
         async purge(id: string) { await tx.execute(sql\`delete from inbound_events where id = \${id}\`); },
         async done(job: Job) { await db.update(aiJobs).set({ status: "succeeded" }).where(heldBy("ai_jobs", job)); },
         async other(id: string) { await db.update(drafts).set({ status: "stale" }).where(eq(drafts.id, id)); },
       };`,
    );
    expect(fencedTableWritesWithoutFence([store])).toEqual(["fixture/store.ts#purge", "fixture/store.ts#stop"]);
  });

  it("(c) sees aliases, quoted, qualified and interpolated table names, upserts and a dynamic table, statement by statement", () => {
    const store = sourceOf(
      "fixture/store.ts",
      `const p = inboundEvents;
       export const store = {
         async alias(id: string) { await db.update(p).set({ attempts: 0 }).where(eq(p.id, id)); },
         async quoted() { await db.execute(sql\`update "ai_jobs" j set attempts = 0\`); },
         async qualified() { await db.execute(sql\`delete from public.inbound_events where id = \${id}\`); },
         async interpolated() { await db.execute(sql\`update \${aiJobs} set attempts = 0\`); },
         async rawUpsert() { await db.execute(sql\`insert into ai_jobs (id) values (\${id}) on conflict (id) do update set attempts = 0\`); },
         async drizzleUpsert() { await db.insert(aiJobs).values({ id }).onConflictDoUpdate({ target: aiJobs.id, set: { attempts: 0 } }); },
         async dynamic(table: string) { await db.execute(sql\`delete from \${sql.raw(table)} where id = \${id}\`); },
         async insertOnly() { await db.insert(aiJobs).values({ id }).onConflictDoNothing(); },
         async mixed(job: Job) {
           await db.update(aiJobs).set({ status: "succeeded" }).where(heldBy("ai_jobs", job));
           await db.update(aiJobs).set({ attempts: 0 }).where(eq(aiJobs.id, job.id));
         },
       };`,
    );
    expect(fencedTableWritesWithoutFence([store])).toEqual(
      ["alias", "drizzleUpsert", "dynamic", "interpolated", "mixed", "qualified", "quoted", "rawUpsert"].map((m) => `fixture/store.ts#${m}`),
    );
  });
});
