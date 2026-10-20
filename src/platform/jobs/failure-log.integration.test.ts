import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "../../test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("scheduler failure records", () => {
  const sql = testSql();
  const tag = uniqueKey();
  let log: typeof import("./failure-log");
  let observe: typeof import("./observe");
  let operations: typeof import("@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-operations-store");
  const orgs: TestOrg[] = [];

  useTestEnv();
  beforeAll(async () => {
    log = await import("./failure-log");
    observe = await import("./observe");
    operations = await import("@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-operations-store");
  });

  afterAll(async () => {
    await sql`delete from job_runs where job like ${`tick:t-${tag}%`} or job like ${`t-${tag}%`}`;
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("keeps one row per job and error, updated on each repeat", async () => {
    const job = `t-${tag}-repeat`;
    const first = new Date("2026-10-15T10:00:00Z");
    await log.recordTickFailure({ job, signature: "db timeout after # ms", message: "db timeout after 5000 ms", occurrences: 1, firstSeenAt: first, now: first });
    await log.recordTickFailure({ job, signature: "db timeout after # ms", message: "db timeout after 7000 ms", occurrences: 40, firstSeenAt: first, now: new Date("2026-10-15T10:40:00Z") });
    await log.recordTickFailure({ job, signature: "other fault", message: "other fault", occurrences: 1, firstSeenAt: first, now: first });
    const rows = await sql`select * from job_runs where job = ${`tick:${job}`} order by slot`;
    expect(rows).toHaveLength(2);
    const repeated = rows.find((r) => r.slot.includes("timeout"))!;
    expect(repeated).toMatchObject({ status: "failed", organization_id: null });
    expect(repeated.error).toContain("db timeout after 7000 ms (40 times since 2026-10-15 10:00 UTC)");
    expect(repeated.started_at).toEqual(first);
    expect(repeated.finished_at).toEqual(new Date("2026-10-15T10:40:00Z"));

    const listed = (await log.recentTickFailures(200)).filter((r) => r.job === job);
    expect(listed).toHaveLength(2);
    expect(listed[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(listed[1].lastSeenAt.getTime());
  });

  it("stays out of the recent-runs list of the LinkedIn jobs panel", async () => {
    const owner = await createTestOrg(sql, "Ticks");
    orgs.push(owner);
    const org = owner.organizationId;
    await log.recordTickFailure({ job: `t-${tag}-hidden`, signature: "s", message: "m", occurrences: 1, firstSeenAt: new Date(), now: new Date() });
    await sql`insert into job_runs (organization_id, job, slot, status) values (${org}, ${`t-${tag}-visible`}, 'manual:1', 'succeeded')`;
    const runs = await operations.drizzleLinkedInOperationsStore.recentRuns(org, 200);
    expect(runs.some((r) => r.job === `t-${tag}-visible`)).toBe(true);
    expect(runs.some((r) => r.job.startsWith("tick:"))).toBe(false);
  });

  it("records a repeating fault of the scheduler's observer once, with its first message", async () => {
    const name = `t-${tag}-observed`;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let run = 1; run <= 4; run++) {
        await observe.tickObserver.observe({ startedAt: new Date().toISOString(), durationMs: 1, jobs: [{ name, processed: 0, more: true, error: `gateway 500 on run ${run}` }] });
      }
    } finally {
      spy.mockRestore();
    }
    const rows = await sql`select status, error from job_runs where job = ${`tick:${name}`}`;
    expect(rows).toEqual([{ status: "failed", error: "gateway 500 on run 1" }]);
  });
});
