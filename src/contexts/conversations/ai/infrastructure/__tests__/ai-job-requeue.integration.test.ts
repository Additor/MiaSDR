import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailInput } from "../../../application/ports";
import { AiError } from "@/contexts/ai/domain/ai-error";
import { AUTO_REQUEUE_BASE_SECONDS, AUTO_REQUEUE_CEILING } from "../../domain/ai-job-requeue";
import { ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import type { Job } from "@/platform/jobs/types";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { replyAiResolverOf } from "@/contexts/conversations/ai/application/ai-ports";

describeDb("failed AI jobs: requeue and sweep", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../../../infrastructure/composition");
  let ops: typeof import("../../application/ai-job-ops");
  let aiJobsApp: typeof import("../../application/ai-jobs");
  let store: typeof import("../drizzle-ai-job-store").drizzleAiJobStore;
  let audit: typeof import("@/platform/db/audit").auditSink;
  let FakeAi: typeof import("../fake-reply-ai").FakeReplyAi;
  const orgs: TestOrg[] = [];
  let counter = 0;
  // One clock for every fixture: a tick of one organization also claims, and releases, the jobs of the others.
  const shared = { offsetMs: 0 };
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  async function fixture(opts: { withKey?: boolean } = {}) {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Requeue", "admin");
    orgs.push(created);
    const { organizationId: org, userId: user } = created;
    const address = `me-${tag}@corp.test`;
    await sql`insert into mailboxes (organization_id, email_address, status, display_name) values (${org}, ${address}, 'connected', 'Mia Rep')`;
    const admin: Actor = { userId: user, organizationId: org, role: "admin" };
    const member: Actor = { userId: user, organizationId: org, role: "member" };
    const ai = new FakeAi();
    const state = { key: opts.withKey ?? true };
    const clock = () => new Date(Date.now() + shared.offsetMs);
    const resolver = replyAiResolverOf(async (o: string) => (o === org && state.key ? ai : null));
    const deps = { jobs: store, replies: (await import("../../../infrastructure/drizzle-reply-store")).drizzleReplyStore, ai: resolver, now: clock, workerId: "test", leaseMs: aiJobsApp.AI_JOB_LEASE_MS, notConfiguredDelayMs: 60_000, audit };
    const [tick] = aiJobsApp.createAiJobs(deps) as [Job];
    const run = () => tick.run({ deadline: Date.now() + 60_000, now: clock });
    const opsDeps = { jobs: store, audit, now: clock };
    const advance = (ms: number) => void (shared.offsetMs += ms);
    return { org, admin, member, address, ai, state, run, opsDeps, advance, tag, resolver, clock };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  async function receive(f: Fx) {
    const n = ++counter;
    const input: InboundEmailInput = {
      organizationId: f.org,
      accountRef: f.address,
      providerThreadId: `rq-thread-${n}`,
      providerMessageId: `rq-msg-${n}`,
      rfcMessageId: `<rq${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.address],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
    };
    const result = await composition.ingestInbound(input);
    await store.enqueueMissing(new Date());
    return result;
  }

  const job = async (org: string, kind = "classification") => (await sql`select * from ai_jobs where organization_id = ${org} and kind = ${kind} order by created_at limit 1`)[0];
  const jobs = (org: string) => sql`select * from ai_jobs where organization_id = ${org} order by created_at`;
  const auditRows = (org: string, action?: string) => sql`select * from audit_log where organization_id = ${org} ${action ? sql`and action = ${action}` : sql``} order by created_at`;

  /** Ticks until the provider failure is final (three attempts, retry waits are under ten minutes). */
  async function failOut(f: Fx, error: Error = new AiError("The AI service is unavailable (status 503).", "transient")) {
    f.ai.failWith = error;
    for (let i = 0; i < 4; i++) {
      await f.run();
      f.advance(10 * MINUTE);
    }
  }

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    ops = await import("../../application/ai-job-ops");
    aiJobsApp = await import("../../application/ai-jobs");
    store = (await import("../drizzle-ai-job-store")).drizzleAiJobStore;
    audit = (await import("@/platform/db/audit")).auditSink;
    FakeAi = (await import("../fake-reply-ai")).FakeReplyAi;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("failure record", () => {
    it("stores the failure kind and the requeue ceiling on the job", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      const j = await job(f.org);
      expect(j).toMatchObject({ status: "failed", attempts: 3 });
      expect(j.payload).toMatchObject({ failureKind: "transient", requeueCeiling: AUTO_REQUEUE_CEILING });
      expect(await sql`select status from reply_type_picks where organization_id = ${f.org}`).toMatchObject([{ status: "failed" }]);
    });

    it("marks a rejected key permanent and an answer in the wrong form as shape", async () => {
      const a = await fixture();
      await receive(a);
      await failOut(a, new AiError("Anthropic rejected the API key.", "permanent"));
      expect((await job(a.org)).payload).toMatchObject({ failureKind: "permanent" });

      const b = await fixture();
      await receive(b);
      await failOut(b, new AiError("The AI answered outside the allowed categories.", "transient", "shape"));
      const j = await job(b.org);
      expect(j).toMatchObject({ status: "failed", attempts: 3 });
      expect(j.payload).toMatchObject({ failureKind: "shape" });
    });

    it("a worker whose lease ran out cannot settle the job another worker reclaimed", async () => {
      const f = await fixture();
      await receive(f);
      const j = await job(f.org);
      const stale = { id: j.id as string, organizationId: f.org, kind: "classification" as const, entityId: j.entity_id as string, attempts: 1, maxAttempts: 3 };
      // The lease ran out and a second worker holds attempt 2.
      await sql`update ai_jobs set status = 'running', attempts = 2, locked_at = now(), locked_by = 'worker-b', started_at = now() where id = ${j.id}`;
      await store.fail(stale, "late failure", new Date());
      await store.retry(stale, "late retry", new Date());
      await store.release(stale, new Date());
      await store.complete(stale, new Date());
      expect(await job(f.org)).toMatchObject({ status: "running", attempts: 2, locked_by: "worker-b" });
      expect(await sql`select 1 from reply_type_picks where organization_id = ${f.org}`).toHaveLength(0);
      expect(await sql`select 1 from events where organization_id = ${f.org} and event_type = 'reply_type_pick.failed'`).toHaveLength(0);
    });

    it("leaves a running job with a live lease alone and takes over one whose lease is older than 5 minutes", async () => {
      const f = await fixture();
      const now = new Date();
      // Top priority, so the claim looks at these two before any job another test left queued.
      const running = (worker: string, lockedAt: Date, priority: number) => sql`
        insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, priority, attempts, locked_at, locked_by, started_at)
        values (${f.org}, 'classification', 'running', 'message', gen_random_uuid(), ${`lease-${worker}-${f.tag}`}, ${priority}, 1, ${lockedAt}, ${worker}, ${lockedAt})
        returning id`;
      const [live] = await running("live", new Date(now.getTime() - MINUTE), 1_000_000);
      const [stale] = await running("stale", new Date(now.getTime() - 6 * MINUTE), 999_999);
      try {
        const claimed = await store.claim("classification", "taker", now, aiJobsApp.AI_JOB_LEASE_MS);
        expect(claimed).toMatchObject({ id: stale.id, attempts: 2 });
        expect(await sql`select locked_by, attempts from ai_jobs where id = ${live.id}`).toEqual([{ locked_by: "live", attempts: 1 }]);
        expect(await sql`select locked_by from ai_jobs where id = ${stale.id}`).toEqual([{ locked_by: "taker" }]);
      } finally {
        await sql`delete from ai_jobs where id in ${sql([live.id, stale.id])}`;
      }
    });

    it("waits min(5 min, 2 s * 2^(attempts-1)) before the next attempt", async () => {
      const f = await fixture();
      await receive(f);
      f.ai.failWith = new AiError("The AI service is unavailable (status 503).", "transient");
      const delayAfterRun = async () => {
        const before = f.clock().getTime();
        await f.run();
        const after = f.clock().getTime();
        const j = await job(f.org);
        expect(j.status).toBe("queued");
        return { from: new Date(j.run_after).getTime() - after, to: new Date(j.run_after).getTime() - before };
      };
      const expectDelay = (d: { from: number; to: number }, ms: number) => {
        expect(d.from).toBeLessThanOrEqual(ms);
        expect(d.to).toBeGreaterThanOrEqual(ms);
      };
      expectDelay(await delayAfterRun(), 2_000);
      f.advance(10 * MINUTE);
      expectDelay(await delayAfterRun(), 4_000);
      // Attempt 10 of 12 would wait 2 s * 2^9, past the 5 minute cap.
      await sql`update ai_jobs set attempts = 9, max_attempts = 12 where organization_id = ${f.org} and kind = 'classification'`;
      f.advance(10 * MINUTE);
      expectDelay(await delayAfterRun(), 5 * MINUTE);
    });

    it("keeps an organization without an AI key waiting: queued, no attempt used, never failed", async () => {
      const f = await fixture({ withKey: false });
      await receive(f);
      for (let i = 0; i < 5; i++) {
        const detail = (await f.run()).detail;
        expect(detail?.not_configured ?? 0).toBeGreaterThanOrEqual(1);
        f.advance(10 * MINUTE);
      }
      expect(await job(f.org)).toMatchObject({ status: "queued", attempts: 0 });
      expect(f.ai.classifyCalls).toBe(0);
      expect(await auditRows(f.org)).toHaveLength(0);
    });
  });

  describe("admin requeue", () => {
    it("returns a failed job to queued once, removes the failed classification and lets the next tick finish it", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      const failed = await job(f.org);

      expect(await ops.requeueAiJob(f.opsDeps, f.admin, failed.id)).toEqual({ requeued: 1, more: false });
      expect(await job(f.org)).toMatchObject({ status: "queued", attempts: 0, failed_at: null, locked_by: null });
      expect((await job(f.org)).payload).toMatchObject({ manualRequeues: 1, autoRequeues: 0 });
      expect(await sql`select id from reply_type_picks where organization_id = ${f.org}`).toHaveLength(0);
      const rows = await auditRows(f.org, "ai_jobs.requeued");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_user_id: f.admin.userId, entity_id: failed.id });
      expect(rows[0].meta).toMatchObject({ mode: "single", count: 1 });

      // A second click finds nothing to do: no second audit row, no second requeue.
      expect(await ops.requeueAiJob(f.opsDeps, f.admin, failed.id)).toEqual({ requeued: 0, more: false });
      expect((await job(f.org)).payload).toMatchObject({ manualRequeues: 1 });
      expect(await auditRows(f.org, "ai_jobs.requeued")).toHaveLength(1);

      f.ai.failWith = null;
      await f.run();
      expect(await job(f.org)).toMatchObject({ status: "succeeded" });
      expect(await sql`select status from reply_type_picks where organization_id = ${f.org}`).toMatchObject([{ status: "auto_applied" }]);
    });

    it("requeues a failed draft job without touching classifications", async () => {
      const f = await fixture();
      await receive(f);
      // Classification succeeds and queues the draft; the provider then fails every draft.
      f.ai.draftWith = () => {
        throw new AiError("timeout", "transient");
      };
      for (let i = 0; i < 4; i++) {
        await f.run();
        f.advance(10 * MINUTE);
      }
      const draftJob = await job(f.org, "initial_draft");
      expect(draftJob.status).toBe("failed");
      expect(await ops.requeueAiJob(f.opsDeps, f.admin, draftJob.id)).toMatchObject({ requeued: 1 });
      expect(await job(f.org, "initial_draft")).toMatchObject({ status: "queued", attempts: 0 });
      expect(await sql`select status from reply_type_picks where organization_id = ${f.org}`).toMatchObject([{ status: "auto_applied" }]);
    });

    it("requeues everything that failed since a time and leaves older failures and other organizations alone", async () => {
      const f = await fixture();
      const other = await fixture();
      await receive(f);
      await receive(f);
      await receive(other);
      await failOut(f);
      await failOut(other);
      const all = await jobs(f.org);
      expect(all).toHaveLength(2);
      // One failure is older than the window.
      await sql`update ai_jobs set failed_at = failed_at - interval '3 days' where id = ${all[0].id}`;

      const summary = await ops.requeueFailedAiJobsSince(f.opsDeps, f.admin, new Date(f.clock().getTime() - 24 * HOUR));
      expect(summary).toEqual({ requeued: 1, more: false });
      const after = await jobs(f.org);
      expect(after.find((j) => j.id === all[0].id)).toMatchObject({ status: "failed" });
      expect(after.find((j) => j.id === all[1].id)).toMatchObject({ status: "queued" });
      expect(await jobs(other.org)).toMatchObject([{ status: "failed" }]);
      const rows = await auditRows(f.org, "ai_jobs.requeued");
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toMatchObject({ mode: "since", count: 1 });
      expect(await auditRows(other.org)).toHaveLength(0);

      // Running it again changes nothing and writes nothing.
      expect(await ops.requeueFailedAiJobsSince(f.opsDeps, f.admin, new Date(f.clock().getTime() - 24 * HOUR))).toEqual({ requeued: 0, more: false });
      expect(await auditRows(f.org, "ai_jobs.requeued")).toHaveLength(1);
    });

    it("answers 404 for another organization's job and changes nothing", async () => {
      const f = await fixture();
      const other = await fixture();
      await receive(other);
      await failOut(other);
      const foreign = await job(other.org);
      await expect(ops.requeueAiJob(f.opsDeps, f.admin, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await job(other.org)).toMatchObject({ status: "failed" });
      expect(await auditRows(other.org)).toHaveLength(0);
      expect(await auditRows(f.org)).toHaveLength(0);
    });

    it("answers 404 for an unknown id and refuses a member", async () => {
      const f = await fixture();
      await expect(ops.requeueAiJob(f.opsDeps, f.admin, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
      await expect(ops.requeueAiJob(f.opsDeps, f.member, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ops.requeueFailedAiJobsSince(f.opsDeps, f.member, new Date(0))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(ops.getFailedAiJobs(f.opsDeps, f.member)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("does nothing to a job that is not failed", async () => {
      const f = await fixture();
      await receive(f);
      const queued = await job(f.org);
      expect(await ops.requeueAiJob(f.opsDeps, f.admin, queued.id)).toEqual({ requeued: 0, more: false });
      expect(await job(f.org)).toMatchObject({ status: "queued" });
      expect(await auditRows(f.org)).toHaveLength(0);
    });

    it("lets two concurrent requeues of one job win once", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      const failed = await job(f.org);
      const results = await Promise.all(Array.from({ length: 6 }, () => ops.requeueAiJob(f.opsDeps, f.admin, failed.id)));
      expect(results.reduce((n, r) => n + r.requeued, 0)).toBe(1);
      expect(await auditRows(f.org, "ai_jobs.requeued")).toHaveLength(1);
      expect((await job(f.org)).payload).toMatchObject({ manualRequeues: 1 });
    });

    it("lists failed jobs with their next automatic requeue", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      const { total, rows } = await ops.getFailedAiJobs(f.opsDeps, f.admin);
      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({ kind: "classification", failureKind: "transient", autoRequeues: 0, requeueCeiling: AUTO_REQUEUE_CEILING });
      expect(rows[0].nextAutoRequeueAt!.getTime() - rows[0].failedAt.getTime()).toBe(AUTO_REQUEUE_BASE_SECONDS * 1000);
      const other = await fixture();
      expect((await ops.getFailedAiJobs(other.opsDeps, other.admin)).total).toBe(0);
    });
  });

  describe("sweep", () => {
    it("waits for the backoff, then requeues, audits once and lets the job finish", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      f.ai.failWith = null;
      const failed = await job(f.org);

      // The failure happened about 30 minutes of fake time ago; move the clock back to just after it.
      await sql`update ai_jobs set failed_at = ${f.clock().toISOString()}::timestamptz where id = ${failed.id}`;
      f.advance(AUTO_REQUEUE_BASE_SECONDS * 1000 - MINUTE);
      expect((await f.run()).detail?.auto_requeued).toBeUndefined();
      expect(await job(f.org)).toMatchObject({ status: "failed" });

      f.advance(2 * MINUTE);
      const detail = (await f.run()).detail;
      expect(detail?.auto_requeued).toBe(1);
      // The same tick claims it and the healthy provider finishes it.
      expect(await job(f.org)).toMatchObject({ status: "succeeded" });
      expect((await job(f.org)).payload).toMatchObject({ autoRequeues: 1 });
      const rows = await auditRows(f.org, "ai_jobs.auto_requeued");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_user_id: null });
      expect(rows[0].meta).toMatchObject({ count: 1, jobIds: [failed.id] });
    });

    it("stops at the ceiling stored on the job", async () => {
      const f = await fixture();
      await receive(f);
      await sql`update ai_jobs set payload = payload || '{"requeueCeiling": 2}'::jsonb where organization_id = ${f.org}`;
      f.ai.failWith = new AiError("The AI service is unavailable (status 503).", "transient");
      // Each cycle: the job runs three attempts and fails, then waits out the backoff (at most 6 hours).
      for (let cycle = 0; cycle < 8; cycle++) {
        for (let i = 0; i < 4; i++) {
          await f.run();
          f.advance(10 * MINUTE);
        }
        f.advance(7 * HOUR);
      }
      const j = await job(f.org);
      expect(j.status).toBe("failed");
      expect(j.payload).toMatchObject({ autoRequeues: 2, requeueCeiling: 2 });
      expect(f.ai.classifyCalls).toBe(9); // one original run and two requeues, three attempts each
      expect(await auditRows(f.org, "ai_jobs.auto_requeued")).toHaveLength(2);
      // The ceiling does not bind a person.
      expect(await ops.requeueAiJob(f.opsDeps, f.admin, j.id)).toMatchObject({ requeued: 1 });
      expect((await job(f.org)).payload).toMatchObject({ autoRequeues: 0, manualRequeues: 1 });
    });

    it("never requeues permanent errors or answers in the wrong form", async () => {
      const a = await fixture();
      await receive(a);
      await failOut(a, new AiError("Anthropic rejected the API key.", "permanent"));
      const b = await fixture();
      await receive(b);
      await failOut(b, new AiError("The AI answered outside the allowed categories.", "transient", "shape"));
      for (const f of [a, b]) {
        f.ai.failWith = null;
        f.advance(24 * HOUR);
        await f.run();
        expect(await job(f.org)).toMatchObject({ status: "failed" });
        expect(await auditRows(f.org)).toHaveLength(0);
      }
    });

    it("requeues a job that failed before failure kinds existed", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      await sql`update ai_jobs set payload = '{}'::jsonb where organization_id = ${f.org}`;
      f.ai.failWith = null;
      f.advance(HOUR);
      expect((await f.run()).detail?.auto_requeued).toBe(1);
    });

    it("skips an organization without an AI key and keeps its ceiling", async () => {
      const f = await fixture();
      await receive(f);
      await failOut(f);
      f.state.key = false;
      f.advance(HOUR);
      for (let i = 0; i < 3; i++) await f.run();
      expect(await job(f.org)).toMatchObject({ status: "failed" });
      expect((await job(f.org)).payload).not.toHaveProperty("autoRequeues");
      f.state.key = true;
      f.ai.failWith = null;
      expect((await f.run()).detail?.auto_requeued).toBe(1);
    });

    it("sweeps each organization on its own", async () => {
      const f = await fixture();
      const other = await fixture();
      await receive(f);
      await receive(other);
      await failOut(f);
      await failOut(other);
      f.ai.failWith = null;
      f.advance(HOUR);
      other.advance(HOUR);
      await f.run();
      // Only f's resolver has a key in this run, so only f's job moved.
      expect(await job(f.org)).toMatchObject({ status: "succeeded" });
      expect(await job(other.org)).toMatchObject({ status: "failed" });
      expect(await auditRows(other.org)).toHaveLength(0);
    });
  });
  describe("jobs the daily cap skipped", () => {
    /** An organization whose cap is 1: the first unknown sender is served, the second is skipped with `daily_cap`. */
    async function cappedPair() {
      const f = await fixture();
      await sql`insert into channel_settings (organization_id, channel, values) values (${f.org}, 'general', ${sql.json({ unknownSenderAiDailyCap: 1 })})`;
      await receive(f);
      await f.run();
      await receive(f);
      await f.run();
      const skipped = (await sql`select * from ai_jobs where organization_id = ${f.org} and status = 'skipped'`)[0];
      return { f, skipped };
    }

    it("requeues a daily_cap job by id once the cap is raised, and the next tick serves it", async () => {
      const { f, skipped } = await cappedPair();
      expect(skipped).toMatchObject({ kind: "classification", status: "skipped", payload: { skipReason: "daily_cap", cap: 1 } });
      await sql`update channel_settings set values = ${sql.json({ unknownSenderAiDailyCap: 10 })} where organization_id = ${f.org} and channel = 'general'`;

      expect(await ops.requeueAiJob(f.opsDeps, f.admin, skipped.id)).toEqual({ requeued: 1, more: false });
      const requeued = (await sql`select * from ai_jobs where id = ${skipped.id}`)[0];
      expect(requeued).toMatchObject({ status: "queued", attempts: 0, completed_at: null, last_error: null });
      expect(requeued.payload).not.toHaveProperty("skipReason");
      expect(requeued.payload).not.toHaveProperty("cap");
      expect((await auditRows(f.org, "ai_jobs.requeued")).length).toBe(1);

      await f.run();
      expect((await sql`select status from ai_jobs where id = ${skipped.id}`)[0].status).toBe("succeeded");
    });

    it("requeues skipped jobs with the since call, and the job skips again while the cap is still used up", async () => {
      const { f, skipped } = await cappedPair();
      const result = await ops.requeueFailedAiJobsSince(f.opsDeps, f.admin, new Date(Date.now() - HOUR));
      expect(result.requeued).toBe(1);
      await f.run();
      expect((await sql`select status, payload from ai_jobs where id = ${skipped.id}`)[0]).toMatchObject({ status: "skipped", payload: { skipReason: "daily_cap" } });
    });

    it("leaves other skip reasons, older skips, other organizations and the sweep alone", async () => {
      const { f, skipped } = await cappedPair();
      const other = await cappedPair();
      await sql`update ai_jobs set payload = payload || '{"skipReason":"other"}'::jsonb where id = ${skipped.id}`;
      expect(await ops.requeueFailedAiJobsSince(f.opsDeps, f.admin, new Date(Date.now() - HOUR))).toMatchObject({ requeued: 0 });
      expect((await sql`select status from ai_jobs where id = ${skipped.id}`)[0].status).toBe("skipped");

      await sql`update ai_jobs set payload = payload || '{"skipReason":"daily_cap"}'::jsonb where id = ${skipped.id}`;
      await sql`update ai_jobs set completed_at = now() - interval '3 hours' where id = ${skipped.id}`;
      expect(await ops.requeueFailedAiJobsSince(f.opsDeps, f.admin, new Date(Date.now() - HOUR))).toMatchObject({ requeued: 0 });

      // A job of another organization is a 404, and its status is unchanged.
      await expect(ops.requeueAiJob(f.opsDeps, f.admin, other.skipped.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await sql`select status from ai_jobs where id = ${other.skipped.id}`)[0].status).toBe("skipped");

      f.advance(24 * HOUR);
      expect(await ops.sweepFailedAiJobs({ ...f.opsDeps, ai: f.resolver })).toBe(0);
      expect((await sql`select status from ai_jobs where id = ${skipped.id}`)[0].status).toBe("skipped");
    });

    it("refuses a member", async () => {
      const { f, skipped } = await cappedPair();
      await expect(ops.requeueAiJob(f.opsDeps, f.member, skipped.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
