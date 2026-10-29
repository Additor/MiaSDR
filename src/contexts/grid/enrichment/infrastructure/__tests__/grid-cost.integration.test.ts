import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "../../../infrastructure/__tests__/grid-test-kit";
import { GridAiError } from "../../application/enrichment-ports";

/** The answerer when AI is off, as the real one fails: a permanent error naming the fix. */
const aiOff = {
  answer: async (): Promise<never> => {
    throw new GridAiError("AI is off. Connect an AI provider in Settings, Integrations.", false);
  },
};

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Covers cascade caps, output sanitizing and no re-bill. */

describeDb("grid auto-run caps and output sanitizing", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];

  let m: {
    providers: typeof import("../../application/enrichment-providers");
    columns: typeof import("../../application/enrichment-columns");
    run: typeof import("../../application/enrichment-run");
    worker: typeof import("../../application/enrichment-worker");
    rows: typeof import("../../../application/row-management");
    adapters: typeof import("../enrichment-adapters");
    pstore: typeof import("../enrichment-provider-store");
    rstore: typeof import("../enrichment-run-store");
    wstore: typeof import("../enrichment-worker-store");
    composition: typeof import("../../../infrastructure/composition");
    crypto: typeof import("@/contexts/integrations/infrastructure/credential-crypto");
  };

  const fake = () => new m.adapters.FakeEnrichmentProvider();

  function deps(f: ReturnType<typeof fake>, workerStore = m.wstore.drizzleGridWorkerStore) {
    const store = m.rstore.drizzleGridRunStore;
    const urlPolicy = { allowedHosts: ["api.vendor.test"] };
    const adapters = m.adapters.createAdapterRegistry({ policy: urlPolicy, net: { resolve: async () => ["93.184.216.34"] }, fake: f });
    const cipher = { encrypt: (p: string) => m.crypto.encryptCredential(p, "x".repeat(40)), decrypt: (e: string) => m.crypto.decryptCredential(e, "x".repeat(40)) };
    return {
      providerDeps: { providers: m.pstore.drizzleProviderStore, cipher, adapters, urlPolicy, allowFake: true },
      runDeps: { store, providers: m.pstore.drizzleProviderStore, adapters, now: () => new Date() },
      columnDeps: { store, providers: m.pstore.drizzleProviderStore, adapters },
      worker: (workerId: string, over: Partial<import("../../application/enrichment-worker").WorkerDeps> = {}) => ({
        store: workerStore,
        providers: m.pstore.drizzleProviderStore,
        adapters,
        cipher,
        ai: aiOff,
        now: () => new Date(),
        workerId,
        leaseMs: 5 * 60_000,
        concurrency: 4,
        callTimeoutMs: 5000,
        ...over,
      }),
    };
  }

  async function fixture(rowCount = 1) {
    const { organizationId: org, actor } = await gridOrg(sql, orgs, "owner", "Cost");
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, key] of ["name", "domain", "about"].entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, ${key}, ${key}, 'text', ${i + 1})`;
    }
    await sql`insert into grid_rows (organization_id, table_id, position, cells)
      select ${org}, ${table}, g, ${sql.json({ name: "Ada Lovelace", domain: "acme.com" } as never)} from generate_series(1, ${rowCount}) g`;
    const ids = (await sql`select id from grid_rows where table_id = ${table} order by position`).map((r) => r.id as string);
    return { org, actor, table, rows: ids };
  }

  const addAiColumn = (org: string, table: string, key: string, position: number) =>
    sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
      values (${org}, ${table}, ${key}, ${key}, 'ai', ${sql.json({ prompt: "Say hi to {{name}}", outputs: [{ key: "line", type: "text" }], outputColumns: {} } as never)}, ${["name"]}, ${position}, true)`;

  const tick = (job: import("@/platform/jobs/types").Job) => job.run({ deadline: Date.now() + 30_000, now: () => new Date() });
  const jobsOf = async (table: string) => (await sql`select status, count(*)::int as n from grid_jobs where table_id = ${table} group by status`).reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {} as Record<string, number>);
  const rowOf = async (rowId: string) => (await sql`select cells, cell_meta from grid_rows where id = ${rowId}`)[0];

  useTestEnv();

  beforeAll(async () => {
    m = {
      providers: await import("../../application/enrichment-providers"),
      columns: await import("../../application/enrichment-columns"),
      run: await import("../../application/enrichment-run"),
      worker: await import("../../application/enrichment-worker"),
      rows: await import("../../../application/row-management"),
      adapters: await import("../enrichment-adapters"),
      pstore: await import("../enrichment-provider-store"),
      rstore: await import("../enrichment-run-store"),
      wstore: await import("../enrichment-worker-store"),
      composition: await import("../../../infrastructure/composition"),
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

  describe("cascade caps", () => {
    it("a 1,000-row paste with two auto-run columns queues at most the cap, marks the rest and reports the count", async () => {
      const { org, actor, table, rows } = await fixture(1000);
      await addAiColumn(org, table, "opener", 10);
      await addAiColumn(org, table, "summary", 11);
      const updates = rows.map((rowId) => ({ rowId, columnKey: "name", value: "Grace Hopper" }));
      const result = await m.rows.editCells(m.composition.gridDeps(), actor, table, updates);

      expect(result.queued).toBe(200);
      expect(result.skippedByCap).toBe(1800);
      expect(await jobsOf(table)).toEqual({ queued: 200 });
      const [{ n }] = await sql`select count(*)::int as n from grid_rows where table_id = ${table} and cell_meta->'opener'->>'status' = 'skipped: cap'`;
      expect(n).toBe(900);
      const skipped = await rowOf(rows[999]);
      expect(skipped.cell_meta.opener).toMatchObject({ status: "skipped: cap" });
      expect(skipped.cell_meta.opener.reason).toMatch(/auto-run limit/);
      // The first rows ran in order; the cap holds back the tail.
      expect((await rowOf(rows[0])).cell_meta.opener).toMatchObject({ status: "queued" });
    }, 30_000);

    it("a single-row edit still queues every auto-run column", async () => {
      const { org, actor, table, rows } = await fixture(3);
      await addAiColumn(org, table, "opener", 10);
      await addAiColumn(org, table, "summary", 11);
      const result = await m.rows.editCells(m.composition.gridDeps(), actor, table, [{ rowId: rows[0], columnKey: "name", value: "Grace" }]);
      expect(result).toMatchObject({ queued: 2, skippedByCap: 0 });
    });

    it("stops at the worst-case cost cap and leaves a skipped mark", async () => {
      const { actor, table, rows } = await fixture(100);
      const f = fake();
      const d = deps(f);
      await m.providers.createProvider(d.providerDeps, actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" }, defaultCostCents: 30 });
      await m.columns.createEnrichmentColumns(d.columnDeps, actor, table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] });
      const changes = new Map(rows.map((id) => [id, ["name"]]));
      const report = await m.run.cascadeFromEdits(d.runDeps, actor.organizationId, table, changes);
      expect(report.queued).toBe(16);
      expect(report.skippedByCap).toBe(84);
      const meta = (await rowOf(rows[99])).cell_meta;
      expect(meta.findEmail.status).toBe("skipped: cap");
    });

    it("applies the same caps to the cascade after a finished cell", async () => {
      const { org, actor, table, rows } = await fixture(1);
      const f = fake();
      const d = deps(f);
      await m.providers.createProvider(d.providerDeps, actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
      await m.columns.createEnrichmentColumns(d.columnDeps, actor, table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] });
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
        values (${org}, ${table}, 'opener', 'opener', 'ai', ${sql.json({ prompt: "Hi {{email}}", outputs: [{ key: "line", type: "text" }], outputColumns: {} } as never)}, ${["email"]}, 50, true)`;
      const worker = m.wstore.drizzleGridWorkerStore;
      await m.rstore.drizzleGridRunStore.enqueue(org, table, [{ rowId: rows[0], columnKey: "findEmail" }], { priority: 0, now: new Date() });
      const [job] = await worker.claim(new Date(), 60_000, 5, "w1");
      // The dependent costs more than the cascade cap, so it waits for a person.
      const ok = await worker.succeed(job, { cells: { email: "a@acme.com" }, meta: { findEmail: { status: "success" } } }, [], { centsByColumn: { opener: 600 } });
      expect(ok).toBe(true);
      expect(await jobsOf(table)).toEqual({ succeeded: 1 });
      expect((await rowOf(rows[0])).cell_meta.opener).toMatchObject({ status: "skipped: cap" });
    });

    it("lets a person run a skipped cell by hand", async () => {
      const { org, actor, table, rows } = await fixture(150);
      await addAiColumn(org, table, "opener", 10);
      await m.rows.editCells(m.composition.gridDeps(), actor, table, rows.map((rowId) => ({ rowId, columnKey: "name", value: "Grace" })));
      expect(await jobsOf(table)).toEqual({ queued: 100 });
      const d = deps(fake());
      const report = await m.run.requestRun(d.runDeps, actor, table, { columnKey: "opener", rowIds: [rows[149]] });
      expect(report.queued).toBe(1);
      expect((await rowOf(rows[149])).cell_meta.opener).toMatchObject({ status: "queued" });
    });

    it("claims at most the per-organization running limit and leaves another organization's jobs claimable", async () => {
      const big = await fixture(40);
      const small = await fixture(2);
      await sql`insert into grid_jobs (organization_id, table_id, row_id, column_key, status, run_after)
        select ${big.org}, ${big.table}, id, 'x', 'queued', now() - interval '1 hour' from grid_rows where table_id = ${big.table}`;
      await sql`insert into grid_jobs (organization_id, table_id, row_id, column_key, status, run_after)
        select ${small.org}, ${small.table}, id, 'x', 'queued', now() - interval '1 minute' from grid_rows where table_id = ${small.table}`;
      const store = m.wstore.drizzleGridWorkerStore;
      const first = await store.claim(new Date(), 60_000, 6, "w1");
      const second = await store.claim(new Date(), 60_000, 6, "w2");
      const third = await store.claim(new Date(), 60_000, 40, "w3");
      const all = [...first, ...second, ...third];
      expect(all.filter((j) => j.organizationId === big.org)).toHaveLength(8);
      expect(all.filter((j) => j.organizationId === small.org)).toHaveLength(2);
    });
  });

  describe("sanitize and never re-bill", () => {
    async function setup() {
      const { org, actor, table, rows } = await fixture(1);
      const f = fake();
      const d = deps(f);
      await m.providers.createProvider(d.providerDeps, actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
      await m.columns.createEnrichmentColumns(d.columnDeps, actor, table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] });
      return { org, actor, table, rows, f, d };
    }

    it("stores a provider answer with NUL and lone surrogates cleaned, after one paid call", async () => {
      const { actor, table, rows, f, d } = await setup();
      f.handler = async () => ({
        outcome: "hit",
        primary: "a\u0000da@acme.com\uD800",
        outputs: { email: "a\u0000da@acme.com", confidence: 90 },
        costCents: 7,
        request: { note: "q\u0000" },
        response: { "ke\u0000y": "v\u0000", nested: [{ x: "\u0001y\uDC00" }] },
      });
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(m.worker.createGridRunJob(d.worker("w1")));
      expect(f.calls).toHaveLength(1);
      expect(await jobsOf(table)).toEqual({ succeeded: 1 });
      const row = await rowOf(rows[0]);
      expect(row.cells.findEmail).toBe("ada@acme.com�");
      expect(row.cells.email).toBe("ada@acme.com");
      const [run] = await sql`select outcome, cost_cents::float as cost, response from grid_cell_runs where row_id = ${rows[0]}`;
      expect(run).toMatchObject({ outcome: "hit", cost: 7 });
      expect(run.response).toEqual({ key: "v", nested: [{ x: "y�" }] });
    });

    it("stores an AI answer with NUL cleaned after one call", async () => {
      const { org, actor, table, rows } = await fixture(1);
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
        values (${org}, ${table}, 'opener', 'opener', 'ai', ${sql.json({ prompt: "Say hi to {{name}}", outputs: [{ key: "line", type: "text" }], outputColumns: { line: "about" } } as never)}, ${["name"]}, 10, false)`;
      const d = deps(fake());
      let calls = 0;
      const ai = { answer: async () => (calls++, { output: { line: "hi\u0000 there" }, provider: "fake", model: "m\u0000" }) };
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(m.worker.createGridRunJob(d.worker("w1", { ai })));
      expect(calls).toBe(1);
      expect((await rowOf(rows[0])).cells.about).toBe("hi there");
      expect(await jobsOf(table)).toEqual({ succeeded: 1 });
    });

    it("ends a cell in a terminal error when the save fails after a paid call, and never calls the provider again", async () => {
      const { actor, table, rows, f } = await setup();
      const base = m.wstore.drizzleGridWorkerStore;
      let saves = 0;
      const broken = {
        ...base,
        succeed: async () => {
          saves++;
          throw new Error("write failed: invalid input syntax for type json");
        },
      };
      const d = deps(f, broken);
      f.handler = async () => ({ outcome: "hit", primary: "ada@acme.com", outputs: { email: "ada@acme.com" }, costCents: 9, request: {}, response: {} });
      await m.run.requestRun(d.runDeps, actor, table);
      const worker = m.worker.createGridRunJob(d.worker("w1"));
      const report = await tick(worker);
      expect(report.detail).toEqual({ failed: 1 });
      expect(f.calls).toHaveLength(1);
      expect(saves).toBe(1);

      const [job] = await sql`select status, attempts, error from grid_jobs where table_id = ${table}`;
      expect(job).toMatchObject({ status: "failed", attempts: 1 });
      expect(job.error).toMatch(/could not be saved/);
      const row = await rowOf(rows[0]);
      expect(row.cell_meta.findEmail).toMatchObject({ status: "error" });
      expect(row.cell_meta.findEmail.error).toMatch(/paid/);
      const runs = await sql`select outcome, cost_cents::float as cost from grid_cell_runs where row_id = ${rows[0]}`;
      expect(runs).toEqual([{ outcome: "hit", cost: 9 }]);

      await sql`update grid_jobs set run_after = now() - interval '1 minute' where table_id = ${table}`;
      await tick(worker);
      await tick(m.worker.createGridRunJob(d.worker("w2")));
      expect(f.calls).toHaveLength(1);
    });
  });
});
