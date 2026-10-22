import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "../../../infrastructure/__tests__/grid-test-kit";
import { GridAiError } from "../../application/enrichment-ports";

/** The answerer when AI is off, as the real one fails: a permanent error naming the fix. */
const aiOff = {
  answer: async (): Promise<never> => {
    throw new GridAiError("AI is off. Connect an AI provider in Settings, Integrations.", false);
  },
};

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Fake provider with latency, no network. */
describeDb("grid run throughput", () => {
  const sql = testSql({ max: 8 });
  const orgs: TestOrg[] = [];
  let m: {
    providers: typeof import("../../application/enrichment-providers");
    columns: typeof import("../../application/enrichment-columns");
    run: typeof import("../../application/enrichment-run");
    worker: typeof import("../../application/enrichment-worker");
    adapters: typeof import("../enrichment-adapters");
    pstore: typeof import("../enrichment-provider-store");
    rstore: typeof import("../enrichment-run-store");
    crypto: typeof import("@/contexts/integrations/infrastructure/credential-crypto");
  };

  function deps(f: InstanceType<typeof m.adapters.FakeEnrichmentProvider>, kick?: () => void) {
    const urlPolicy = { allowedHosts: [] as string[] };
    const adapters = m.adapters.createAdapterRegistry({ policy: urlPolicy, fake: f });
    const cipher = { encrypt: (p: string) => m.crypto.encryptCredential(p, "x".repeat(40)), decrypt: (e: string) => m.crypto.decryptCredential(e, "x".repeat(40)) };
    return {
      providerDeps: { providers: m.pstore.drizzleProviderStore, cipher, adapters, urlPolicy, allowFake: true },
      runDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters, now: () => new Date(), kick },
      columnDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters },
      worker: (workerId: string, over: Partial<import("../../application/enrichment-worker").WorkerDeps> = {}) => ({
        store: m.rstore.drizzleGridRunStore,
        providers: m.pstore.drizzleProviderStore,
        adapters,
        cipher,
        ai: aiOff,
        now: () => new Date(),
        workerId,
        leaseMs: 5 * 60_000,
        concurrency: 8,
        callTimeoutMs: 5000,
        ...over,
      }),
    };
  }

  async function fixture(rowCount: number) {
    const { organizationId: org, actor } = await gridOrg(sql, orgs, "owner");
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, key] of ["name", "domain", "about"].entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, ${key}, ${key}, 'text', ${i + 1})`;
    }
    const values = Array.from({ length: rowCount }, (_, i) => ({ organization_id: org, table_id: table, position: i + 1, cells: sql.json({ name: `Person${i} Test`, domain: "acme.com" } as never) }));
    for (let i = 0; i < values.length; i += 500) await sql`insert into grid_rows ${sql(values.slice(i, i + 500))}`;
    return { org, actor, table };
  }

  async function setupRun(rowCount: number, delayMs: number, kick?: () => void, cents = 0) {
    const f = new m.adapters.FakeEnrichmentProvider();
    f.delayMs = delayMs;
    const d = deps(f, kick);
    const f1 = await fixture(rowCount);
    await m.providers.createProvider(d.providerDeps, f1.actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" }, defaultCostCents: cents });
    await m.columns.createEnrichmentColumns(d.columnDeps, f1.actor, f1.table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] });
    return { f, d, ...f1 };
  }

  const tick = (job: import("@/platform/jobs/types").Job, ms = 30_000) => job.run({ deadline: Date.now() + ms, now: () => new Date() });
  const jobs = async (table: string) => (await sql`select status, count(*)::int as n from grid_jobs where table_id = ${table} group by status`).reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {} as Record<string, number>);

  useTestEnv();
  beforeAll(async () => {
    m = {
      providers: await import("../../application/enrichment-providers"),
      columns: await import("../../application/enrichment-columns"),
      run: await import("../../application/enrichment-run"),
      worker: await import("../../application/enrichment-worker"),
      adapters: await import("../enrichment-adapters"),
      pstore: await import("../enrichment-provider-store"),
      rstore: await import("../enrichment-run-store"),
      crypto: await import("@/contexts/integrations/infrastructure/credential-crypto"),
    };
  });

  beforeEach(async () => {
    await sql`delete from grid_jobs`;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("runs 250 cells in one pass with one provider call per cell", async () => {
    const { f, d, actor, table } = await setupRun(250, 3);
    expect((await m.run.requestRun(d.runDeps, actor, table, { maxRows: 1000 })).queued).toBe(250);
    const result = await tick(m.worker.createGridRunJob(d.worker("w1")));
    expect(result).toMatchObject({ processed: 250, more: false });
    expect(f.calls).toHaveLength(250);
    expect(new Set(f.calls.map((c) => c.inputs.fullName)).size).toBe(250);
    expect(await jobs(table)).toEqual({ succeeded: 250 });
  }, 60_000);

  it("gives a second organization's single cell a place in the first claim behind a large queue", async () => {
    const big = await setupRun(60, 1);
    await m.run.requestRun(big.d.runDeps, big.actor, big.table);
    const small = await setupRun(1, 1);
    await m.run.requestRun(small.d.runDeps, small.actor, small.table);
    // The small organization queued later than all 60 cells of the large one.
    const first = await m.rstore.drizzleGridRunStore.claim(new Date(), 5 * 60_000, 4, "w1");
    expect(first).toHaveLength(4);
    expect(first.map((j) => j.organizationId)).toContain(small.org);
    const [{ n }] = await sql`select count(*)::int as n from grid_jobs where status = 'queued' and organization_id = ${big.org}`;
    expect(n).toBeGreaterThan(50);
  });

  async function manyOrgQueue(orgCount: number, rows: number) {
    const made = [];
    for (let i = 0; i < orgCount; i++) {
      const o = await setupRun(rows, 0);
      await m.run.requestRun(o.d.runDeps, o.actor, o.table);
      made.push(o);
    }
    return made;
  }
  const lease = 5 * 60_000;

  it("two concurrent claimers over a queue larger than both limits claim disjoint sets that fill both limits", async () => {
    await manyOrgQueue(10, 10);
    const store = m.rstore.drizzleGridRunStore;
    for (let round = 0; round < 5; round++) {
      await sql`update grid_jobs set status = 'queued', locked_at = null, attempts = 0`;
      const [a, b] = await Promise.all([store.claim(new Date(), lease, 8, "w1"), store.claim(new Date(), lease, 8, "w2")]);
      expect(a.length + b.length).toBe(16);
      expect(a).toHaveLength(8);
      expect(b).toHaveLength(8);
      expect(new Set([...a, ...b].map((j) => j.id)).size).toBe(16);
    }
  }, 60_000);

  it("fills the limit when a concurrent claimer holds the top candidates", async () => {
    const made = await manyOrgQueue(10, 10);
    const store = m.rstore.drizzleGridRunStore;
    // Hold the row locks of the first job of four organizations, the head of the claim order.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedReady = new Promise<void>((r) => (locked = r));
    const holder = sql.begin(async (tx) => {
      for (const o of made.slice(0, 4)) {
        await tx`select id from grid_jobs where organization_id = ${o.org} order by priority desc, run_after, created_at limit 1 for update`;
      }
      locked();
      await held;
    });
    await lockedReady;
    try {
      const claimed = await store.claim(new Date(), lease, 8, "w1");
      expect(claimed).toHaveLength(8);
      expect(new Set(claimed.map((j) => j.id)).size).toBe(8);
    } finally {
      release();
      await holder;
    }
  }, 60_000);

  it("leaves exhausted jobs alone when the sweep is off and fails them when it is on", async () => {
    const o = await setupRun(2, 0);
    await m.run.requestRun(o.d.runDeps, o.actor, o.table);
    await sql`update grid_jobs set attempts = max_attempts where id = (select id from grid_jobs where table_id = ${o.table} order by created_at limit 1)`;
    const store = m.rstore.drizzleGridRunStore;
    const first = await store.claim(new Date(), lease, 8, "w1", { sweepExhausted: false });
    expect(first).toHaveLength(1);
    expect((await jobs(o.table)).failed).toBeUndefined();
    await store.claim(new Date(), lease, 8, "w1", { sweepExhausted: true });
    expect((await jobs(o.table)).failed).toBe(1);
  });

  it("concurrent claimers never push an organization past its running cap", async () => {
    const { ORG_MAX_RUNNING_CELLS: cap } = await import("../../domain/enrichment-run-limits");
    const o = await setupRun(30, 0);
    await m.run.requestRun(o.d.runDeps, o.actor, o.table);
    const store = m.rstore.drizzleGridRunStore;
    // A trigger slows each claim's update, so a second claimer starts while the first is uncommitted. That is the window the race needs.
    await sql`create or replace function grid_slow_claim() returns trigger language plpgsql as $$ begin if new.status = 'running' and old.status = 'queued' then perform pg_sleep(0.05); end if; return new; end $$`;
    await sql`create trigger grid_slow_claim before update on grid_jobs for each row execute function grid_slow_claim()`;
    try {
      for (let round = 0; round < 12; round++) {
        await sql`alter table grid_jobs disable trigger grid_slow_claim`;
        await sql`update grid_jobs set status = 'queued', locked_at = null, attempts = 0 where table_id = ${o.table}`;
        await sql`update grid_jobs set status = 'running', locked_at = now() where id in (select id from grid_jobs where table_id = ${o.table} order by created_at limit ${cap - 1})`;
        await sql`alter table grid_jobs enable trigger grid_slow_claim`;
        const claims = await Promise.all(["w1", "w2", "w3", "w4"].map((worker) => store.claim(new Date(), lease, 8, worker, { sweepExhausted: false })));
        const [{ n }] = await sql`select count(*)::int as n from grid_jobs where table_id = ${o.table} and status = 'running'`;
        expect(n, `round ${round}`).toBeLessThanOrEqual(cap);
        expect(claims.flat().length, `round ${round}`).toBeLessThanOrEqual(1);
      }
    } finally {
      await sql`drop trigger if exists grid_slow_claim on grid_jobs`;
      await sql`drop function if exists grid_slow_claim()`;
    }
  }, 120_000);

  it("kicks once after the queue write commits, and not when nothing was queued", async () => {
    // Each kick reads the queue on a separate connection, so it sees only committed jobs.
    const kicks: Array<Promise<number>> = [];
    let table = "";
    const { d, actor, table: t } = await setupRun(3, 0, () => {
      kicks.push(sql`select count(*)::int as n from grid_jobs where table_id = ${table}`.then((r) => r[0].n as number));
    });
    table = t;
    await m.run.requestRun(d.runDeps, actor, table);
    expect(await Promise.all(kicks)).toEqual([3]);
    // The kick runs inside requestRun, so a request that queued nothing has made no kick by the time it resolves.
    await m.run.cancelRun(d.runDeps, actor, table);
    kicks.length = 0;
    await expect(m.run.requestRun(d.runDeps, actor, table, { columnKey: "findEmail", rowIds: [] })).resolves.toMatchObject({ queued: 0 });
    expect(kicks).toEqual([]);
  });

  it("never lets a throwing kick fail the request", async () => {
    const { d, actor, table } = await setupRun(2, 0, () => {
      throw new Error("kick exploded");
    });
    await expect(m.run.requestRun(d.runDeps, actor, table)).resolves.toMatchObject({ queued: 2 });
    expect(await jobs(table)).toEqual({ queued: 2 });
  });

  it("still refuses a run over the row cap or the cost cap before queuing, and kicks nothing", async () => {
    let kicks = 0;
    const { d, actor, table } = await setupRun(30, 0, () => void kicks++, 5);
    await expect(m.run.requestRun(d.runDeps, actor, table, { maxRows: 10 })).rejects.toThrow(/limit of 10/);
    await expect(m.run.requestRun(d.runDeps, actor, table, { maxCostCents: 100 })).rejects.toThrow(/worst-case cost/);
    expect(await jobs(table)).toEqual({});
    expect(kicks).toBe(0);
  });
});
