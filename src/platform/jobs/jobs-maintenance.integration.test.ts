import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "../../test-support/db";
import { DEFAULT_RETENTION } from "./prune";
import type { RolloverStep } from "./rollover";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("slot claims, daily rollover and history pruning", () => {
  const sql = testSql({ max: 4 });
  let slots: typeof import("./slots");
  let rollover: typeof import("./rollover");
  let prune: typeof import("./prune");
  const tag = uniqueKey();
  const orgs: string[] = [];
  const jobLike = `t-${tag}%`;
  const day = 86_400_000;

  useTestEnv();
  beforeAll(async () => {
    slots = await import("./slots");
    rollover = await import("./rollover");
    prune = await import("./prune");
  });

  afterAll(async () => {
    await sql`delete from job_runs where job like ${jobLike} or job like 'daily-rollover:%:t-' || ${tag} || '%'`;
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  async function org(timeZone?: string) {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('Roll', ${"roll-" + tag + "-" + orgs.length}) returning id`;
    orgs.push(id);
    if (timeZone) await sql`insert into channel_settings (organization_id, channel, values) values (${id}, 'general', ${sql.json({ timeZone })})`;
    return id as string;
  }

  describe("claimSlot", () => {
    it("gives one winner among concurrent claimers", async () => {
      const now = new Date();
      const results = await Promise.all(Array.from({ length: 12 }, () => slots.claimSlot(`t-${tag}-race`, "2026-10-14", { now })));
      expect(results.filter(Boolean)).toHaveLength(1);
      const rows = await sql`select * from job_runs where job = ${`t-${tag}-race`}`;
      expect(rows).toHaveLength(1);
    });

    it("keeps slots and organizations apart", async () => {
      const now = new Date();
      const a = await org();
      const b = await org();
      expect(await slots.claimSlot(`t-${tag}-iso`, "d1", { now, organizationId: a })).not.toBeNull();
      expect(await slots.claimSlot(`t-${tag}-iso`, "d1", { now, organizationId: b })).not.toBeNull();
      expect(await slots.claimSlot(`t-${tag}-iso`, "d2", { now, organizationId: a })).not.toBeNull();
      expect(await slots.claimSlot(`t-${tag}-iso`, "d1", { now, organizationId: a })).toBeNull();
      expect(await slots.claimSlot(`t-${tag}-iso`, "d1", { now })).not.toBeNull();
    });

    it("lets a crashed worker's slot be retaken after the lease, and fences the old owner", async () => {
      const t0 = new Date("2026-10-14T10:00:00Z");
      const job = `t-${tag}-lease`;
      const first = await slots.claimSlot(job, "s", { now: t0, leaseMs: 60_000 });
      expect(first).not.toBeNull();
      expect(await slots.claimSlot(job, "s", { now: new Date(t0.getTime() + 59_000) })).toBeNull();
      const second = await slots.claimSlot(job, "s", { now: new Date(t0.getTime() + 61_000), leaseMs: 60_000 });
      expect(second).not.toBeNull();
      // The displaced owner can neither finish nor extend.
      expect(await slots.finishSlot(first!, { status: "succeeded" })).toBe(false);
      expect(await slots.extendSlot(first!, 60_000)).toBe(false);
      expect(await slots.finishSlot(second!, { status: "succeeded" })).toBe(true);
    });

    it("extends a lease", async () => {
      const t0 = new Date("2026-10-14T10:00:00Z");
      const job = `t-${tag}-extend`;
      const claim = await slots.claimSlot(job, "s", { now: t0, leaseMs: 60_000 });
      expect(await slots.extendSlot(claim!, 600_000, new Date(t0.getTime() + 30_000))).toBe(true);
      expect(await slots.claimSlot(job, "s", { now: new Date(t0.getTime() + 120_000) })).toBeNull();
    });

    it("never retakes a succeeded slot, and retakes a failed one after its delay", async () => {
      const t0 = new Date("2026-10-14T10:00:00Z");
      const ok = await slots.claimSlot(`t-${tag}-done`, "s", { now: t0 });
      await slots.finishSlot(ok!, { status: "succeeded" }, t0);
      expect(await slots.claimSlot(`t-${tag}-done`, "s", { now: new Date(t0.getTime() + 10 * day) })).toBeNull();

      const bad = await slots.claimSlot(`t-${tag}-fail`, "s", { now: t0 });
      await slots.finishSlot(bad!, { status: "failed", error: "boom", retryAfterMs: 60_000 }, t0);
      expect(await slots.claimSlot(`t-${tag}-fail`, "s", { now: new Date(t0.getTime() + 30_000) })).toBeNull();
      const retry = await slots.claimSlot(`t-${tag}-fail`, "s", { now: new Date(t0.getTime() + 61_000) });
      expect(retry).not.toBeNull();
      const [row] = await sql`select status, error from job_runs where id = ${retry!.id}`;
      expect(row).toMatchObject({ status: "running", error: null });
    });
  });

  describe("daily rollover", () => {
    const recorder = (name: string, calls: string[], failOnce?: { org: string }): RolloverStep => {
      let failed = false;
      return {
        name,
        async run({ organizationId, day: d }) {
          if (!orgs.includes(organizationId)) return;
          if (failOnce?.org === organizationId && !failed) {
            failed = true;
            throw new Error("step failed");
          }
          calls.push(`${organizationId}:${d}`);
        },
      };
    };
    const ctx = (now: Date, budgetMs = 60_000) => ({ deadline: Date.now() + budgetMs, now: () => now });

    it("runs once per local day per organization, with two zones", async () => {
      const seoul = await org("Asia/Seoul");
      const la = await org("America/Los_Angeles");
      const calls: string[] = [];
      const job = rollover.createDailyRolloverJob([recorder(`t-${tag}-a`, calls)]);

      // 23:30Z on the 14th: Seoul is already the 15th, Los Angeles still the 14th.
      const t1 = new Date("2026-10-14T23:30:00Z");
      await job.run(ctx(t1));
      await job.run(ctx(t1));
      await Promise.all([job.run(ctx(t1)), job.run(ctx(t1))]);
      expect(calls.filter((c) => c.startsWith(seoul))).toEqual([`${seoul}:2026-10-15`]);
      expect(calls.filter((c) => c.startsWith(la))).toEqual([`${la}:2026-10-14`]);

      // 07:30Z on the 15th: Seoul has not rolled again, Los Angeles has not (00:30 on the 15th, new day).
      await job.run(ctx(new Date("2026-10-15T07:30:00Z")));
      expect(calls.filter((c) => c.startsWith(seoul))).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith(la))).toEqual([`${la}:2026-10-14`, `${la}:2026-10-15`]);

      const [{ n }] = await sql`select count(*)::int as n from job_runs where job = ${rollover.rolloverJobName(seoul, `t-${tag}-a`, "2026-10-15")} and status = 'succeeded'`;
      expect(n).toBe(1);
    });

    it("runs steps as independent claims and retries only the failed one", async () => {
      const o = await org();
      const calls: string[] = [];
      const bad = recorder(`t-${tag}-bad`, calls, { org: o });
      const good = recorder(`t-${tag}-good`, calls);
      const job = rollover.createDailyRolloverJob([bad, good]);
      const t = new Date();
      const first = await job.run(ctx(t));
      expect(first.detail?.failed).toBeGreaterThanOrEqual(1);
      expect(calls.filter((c) => c.startsWith(o))).toHaveLength(1); // good ran

      // Inside the retry delay the failed step stays closed.
      await job.run(ctx(new Date(t.getTime() + 60_000)));
      expect(calls.filter((c) => c.startsWith(o))).toHaveLength(1);
      // After it, only the failed step runs again.
      await job.run(ctx(new Date(t.getTime() + rollover.ROLLOVER_RETRY_MS + 1000)));
      expect(calls.filter((c) => c.startsWith(o))).toHaveLength(2);
    });

    it("reports more work when the budget is spent and resumes later", async () => {
      const o = await org();
      const calls: string[] = [];
      const job = rollover.createDailyRolloverJob([recorder(`t-${tag}-b1`, calls), recorder(`t-${tag}-b2`, calls)]);
      const t = new Date();
      const cut = await job.run(ctx(t, -1));
      expect(cut.more).toBe(true);
      expect(calls).toHaveLength(0);
      await job.run(ctx(t));
      expect(calls.filter((c) => c.startsWith(o))).toHaveLength(2);
    });
  });

  describe("history pruning", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * day).toISOString();
    const retention = DEFAULT_RETENTION;

    // pruneHistory deletes every eligible row in the shared tables, not only this run's. Two runs of this file
    // against one database would delete each other's rows, and rows orphaned by an earlier failed run would
    // inflate the batch counts. A session advisory lock serializes the runs, and a drain before the first test
    // removes whatever was already eligible, so only this run's rows are left to count.
    const PRUNE_LOCK = 7_240_118;
    let lock: postgres.ReservedSql | undefined;
    beforeAll(async () => {
      lock = await sql.reserve();
      await lock`select pg_advisory_lock(${PRUNE_LOCK})`;
      for (;;) {
        const drained = await prune.pruneHistory({ now, retention, deadline: Date.now() + 60_000 });
        if (!drained.more) break;
      }
    }, 120_000);
    afterAll(async () => {
      await sql`delete from inbound_events where provider_event_key like ${`t-${tag}-%`}`;
      await sql`delete from users where email = ${`t-${tag}@x.test`}`;
      await sql`delete from verifications where identifier = ${`t-${tag}`}`;
      if (lock) {
        await lock`select pg_advisory_unlock(${PRUNE_LOCK})`;
        lock.release();
      }
    });

    async function event(status: string, createdDaysAgo: number, key: string) {
      const [{ id }] = await sql`
        insert into inbound_events (provider, provider_event_key, event_type, payload, status, created_at, processed_at)
        values ('unipile', ${`t-${tag}-${key}`}, 'x', '{}'::jsonb, ${status}, ${ago(createdDaysAgo)}, ${status === "pending" ? null : ago(createdDaysAgo)})
        returning id`;
      return id as string;
    }
    const exists = async (table: string, id: string) => (await sql.unsafe(`select 1 from ${table} where id = $1`, [id])).length === 1;

    it("deletes old terminal history and keeps everything else", async () => {
      const o = await org();
      const oldRun = (await sql`insert into job_runs (job, slot, status, started_at, finished_at) values (${`t-${tag}-p1`}, 's', 'succeeded', ${ago(31)}, ${ago(31)}) returning id`)[0].id;
      const newRun = (await sql`insert into job_runs (job, slot, status, started_at) values (${`t-${tag}-p2`}, 's', 'succeeded', ${ago(29)}) returning id`)[0].id;
      const liveRunning = (await sql`insert into job_runs (job, slot, status, started_at, lease_until) values (${`t-${tag}-p3`}, 's', 'running', ${ago(40)}, ${now.toISOString()}::timestamptz + interval '1 hour') returning id`)[0].id;
      const crashedRunning = (await sql`insert into job_runs (job, slot, status, started_at, lease_until) values (${`t-${tag}-p4`}, 's', 'running', ${ago(40)}, ${ago(39)}) returning id`)[0].id;

      const doneOld = await event("done", 31, "e1");
      const skippedOld = await event("skipped", 31, "e2");
      const doneNew = await event("done", 29, "e3");
      const failed60 = await event("failed", 60, "e4");
      const failed100 = await event("failed", 100, "e5");
      const pendingOld = await event("pending", 200, "e6");
      const processingOld = await event("processing", 200, "e7");

      const ids = {
        oldSession: (await sql`insert into users (name, email, email_verified) values ('u', ${`t-${tag}@x.test`}, true) returning id`)[0].id as string,
      };
      const [{ id: oldSess }] = await sql`insert into sessions (token, user_id, expires_at) values (${`t-${tag}-s1`}, ${ids.oldSession}, ${ago(3)}) returning id`;
      const [{ id: liveSess }] = await sql`insert into sessions (token, user_id, expires_at) values (${`t-${tag}-s2`}, ${ids.oldSession}, ${new Date(now.getTime() + day).toISOString()}) returning id`;
      const [{ id: oldVer }] = await sql`insert into verifications (identifier, value, expires_at) values (${`t-${tag}`}, 'v', ${ago(3)}) returning id`;
      const [{ id: liveVer }] = await sql`insert into verifications (identifier, value, expires_at) values (${`t-${tag}`}, 'v', ${new Date(now.getTime() + 3600_000).toISOString()}) returning id`;

      // Business data of the same age is out of scope.
      void o;
      const result = await prune.pruneHistory({ now, retention, deadline: Date.now() + 60_000 });

      expect(result.more).toBe(false);
      expect(await exists("job_runs", oldRun)).toBe(false);
      expect(await exists("job_runs", crashedRunning)).toBe(false);
      expect(await exists("job_runs", newRun)).toBe(true);
      expect(await exists("job_runs", liveRunning)).toBe(true);
      expect(await exists("inbound_events", doneOld)).toBe(false);
      expect(await exists("inbound_events", skippedOld)).toBe(false);
      expect(await exists("inbound_events", doneNew)).toBe(true);
      expect(await exists("inbound_events", failed60)).toBe(true);
      expect(await exists("inbound_events", failed100)).toBe(false);
      expect(await exists("inbound_events", pendingOld)).toBe(true);
      expect(await exists("inbound_events", processingOld)).toBe(true);
      expect(await exists("sessions", oldSess)).toBe(false);
      expect(await exists("sessions", liveSess)).toBe(true);
      expect(await exists("verifications", oldVer)).toBe(false);
      expect(await exists("verifications", liveVer)).toBe(true);

      await sql`delete from inbound_events where provider_event_key like ${`t-${tag}-%`}`;
      await sql`delete from job_runs where id in (${newRun}, ${liveRunning})`;
      await sql`delete from verifications where identifier = ${`t-${tag}`}`;
      await sql`delete from users where id = ${ids.oldSession}`;
    });

    it("never touches business tables, and honors the retention it is given", async () => {
      const o = await org();
      const [{ id: person }] = await sql`insert into people (organization_id, full_name, source) values (${o}, 'Old Person', 'import') returning id`;
      await sql`update people set created_at = ${ago(400)} where id = ${person}`;
      const doneEvent = await event("done", 10, "e8");
      await prune.pruneHistory({ now, retention: { ...retention, inboundDone: 5 }, deadline: Date.now() + 60_000 });
      expect(await exists("inbound_events", doneEvent)).toBe(false);
      expect(await exists("people", person)).toBe(true);
    });

    it("deletes in bounded batches and reports more", async () => {
      for (let i = 0; i < 7; i++) await event("done", 50, `bulk${i}`);
      const first = await prune.pruneHistory({ now, retention, deadline: Date.now() + 60_000, batchSize: 3, maxBatches: 2 });
      expect(first.deleted.inbound_events_done).toBe(6);
      expect(first.more).toBe(true);
      const second = await prune.pruneHistory({ now, retention, deadline: Date.now() + 60_000, batchSize: 3, maxBatches: 2 });
      expect(second.deleted.inbound_events_done).toBe(1);
      expect(second.more).toBe(false);
    });

    it("stops at the deadline", async () => {
      await event("done", 50, "late");
      const r = await prune.pruneHistory({ now, retention, deadline: Date.now() - 1 });
      expect(r.more).toBe(true);
      expect(r.deleted.inbound_events_done).toBe(0);
      await sql`delete from inbound_events where provider_event_key = ${`t-${tag}-late`}`;
    });

    it("prunes ai_jobs only when succeeded and old", async () => {
      // ai_jobs needs a message entity; a bare uuid is enough because the entity is polymorphic.
      const o = await org();
      const mk = async (status: string, completedAgo: number | null, n: number) => {
        const entity = crypto.randomUUID();
        const running = status === "running";
        const [{ id }] = await sql`
          insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, attempts, last_error, failed_at, completed_at, locked_at, locked_by, started_at)
          values (${o}, 'classification', ${status}, 'message', ${entity}, ${`t-${tag}-ai${n}`}, 0,
            ${status === "failed" ? "x" : null}, ${status === "failed" ? ago(60) : null}, ${completedAgo === null ? null : ago(completedAgo)},
            ${running ? ago(0) : null}, ${running ? "w" : null}, ${running ? ago(0) : null})
          returning id`;
        return id as string;
      };
      const oldOk = await mk("succeeded", 31, 1);
      const newOk = await mk("succeeded", 3, 2);
      const oldFailed = await mk("failed", null, 3);
      const queued = await mk("queued", null, 4);
      await prune.pruneHistory({ now, retention, deadline: Date.now() + 60_000 });
      expect(await exists("ai_jobs", oldOk)).toBe(false);
      expect(await exists("ai_jobs", newOk)).toBe(true);
      expect(await exists("ai_jobs", oldFailed)).toBe(true);
      expect(await exists("ai_jobs", queued)).toBe(true);
    });

    it("the job runs once per UTC day", async () => {
      const job = prune.createHistoryPruneJob(() => retention);
      const t = new Date("2031-01-01T00:10:00Z");
      const ctx = { deadline: Date.now() + 60_000, now: () => t };
      const first = await job.run(ctx);
      expect(first.more).toBe(false);
      const second = await job.run(ctx);
      expect(second).toEqual({ processed: 0, more: false });
      await sql`delete from job_runs where job = 'history-prune' and slot = '2031-01-01'`;
    });
  });
});
