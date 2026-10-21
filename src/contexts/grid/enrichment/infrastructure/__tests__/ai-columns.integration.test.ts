import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "../../../infrastructure/__tests__/grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Stubbed AI answerer and the fake provider, no network. */

describeDb("AI columns: output types, editing and placement", () => {
  const sql = testSql({ max: 4 });
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
    columnsUc: typeof import("../../../application/column-management");
    structure: typeof import("../../../application/structure-management");
    gridDeps: () => import("../../../application/ports").GridDeps;
  };

  function deps() {
    const urlPolicy = { allowedHosts: [] as string[] };
    const adapters = m.adapters.createAdapterRegistry({ policy: urlPolicy, fake: new m.adapters.FakeEnrichmentProvider() });
    const cipher = { encrypt: (p: string) => m.crypto.encryptCredential(p, "x".repeat(40)), decrypt: (e: string) => m.crypto.decryptCredential(e, "x".repeat(40)) };
    return {
      providerDeps: { providers: m.pstore.drizzleProviderStore, cipher, adapters, urlPolicy, allowFake: true },
      runDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters, now: () => new Date() },
      columnDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters },
      worker: (over: Partial<import("../../application/enrichment-worker").WorkerDeps> = {}) =>
        m.worker.createGridRunJob({ store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters, cipher, ai: { answer: async () => null }, now: () => new Date(), workerId: "w1", leaseMs: 300_000, concurrency: 4, callTimeoutMs: 5000, ...over }),
    };
  }

  async function fixture(rowCount = 1) {
    const { organizationId: org, actor } = await gridOrg(sql, orgs, "owner", "Grid");
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, key] of ["name", "company"].entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, ${key}, ${key}, 'text', ${i + 1})`;
    }
    const rows: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const [{ id }] = await sql`insert into grid_rows (organization_id, table_id, position, cells) values (${org}, ${table}, ${i + 1}, ${sql.json({ name: `Ada${i}`, company: "Acme" } as never)}) returning id`;
      rows.push(id);
    }
    return { org, actor, table, rows };
  }

  const answerer = (output: Record<string, unknown>) => {
    const calls: unknown[] = [];
    return { calls, ai: { answer: async (_org: string, input: unknown) => (calls.push(input), { output, provider: "fake", model: "fake-1" }) } };
  };
  const tick = (job: import("@/platform/jobs/types").Job) => job.run({ deadline: Date.now() + 30_000, now: () => new Date() });
  const rowOf = async (id: string) => (await sql`select cells, cell_meta from grid_rows where id = ${id}`)[0];
  const jobStates = async (table: string) => (await sql`select status, count(*)::int as n from grid_jobs where table_id = ${table} group by status`).reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {} as Record<string, number>);
  const order = async (table: string) => (await sql`select key, position from grid_columns where table_id = ${table} order by position, id`).map((r) => ({ key: r.key as string, position: r.position as number }));

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
      columnsUc: await import("../../../application/column-management"),
      structure: await import("../../../application/structure-management"),
      gridDeps: (await import("../../../infrastructure/composition")).gridDeps,
    };
  });
  beforeEach(async () => {
    await sql`delete from grid_jobs`;
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("output types", () => {
    const outputs = [
      { key: "mail", type: "email" as const },
      { key: "site", type: "url" as const },
      { key: "since", type: "date" as const },
      { key: "extra", type: "json" as const },
      { key: "score", type: "number" as const },
    ];

    it("converts valid answers and stores them under the output column's type", async () => {
      const { actor, table, rows } = await fixture();
      const d = deps();
      const created = await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "Profile", prompt: "Profile {{name}}", outputs });
      expect(created.filter((c) => c.type === "ai_output").map((c) => c.config.valueType)).toEqual(["email", "url", "date", "json", "number"]);
      await m.run.requestRun(d.runDeps, actor, table);
      const a = answerer({ mail: " ada@acme.test ", site: "https://acme.test/ada", since: "2026-03-01T09:00:00Z", extra: '{"tags":["a","b"]}', score: 7 });
      await tick(d.worker({ ai: a.ai }));
      const row = await rowOf(rows[0]);
      expect(row.cells).toMatchObject({ mail: "ada@acme.test", site: "https://acme.test/ada", since: "2026-03-01", extra: { tags: ["a", "b"] }, score: 7, profile: "Completed" });
      expect(row.cell_meta.mail).toMatchObject({ status: "success" });
    });

    it("stores a cell error for a rejected answer, saves the other fields, and does not call the model again", async () => {
      const { actor, table, rows } = await fixture();
      const d = deps();
      await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "Profile", prompt: "Profile {{name}}", outputs });
      await m.run.requestRun(d.runDeps, actor, table);
      const a = answerer({ mail: "not an email", site: "https://acme.test", since: "next Tuesday", extra: "{oops", score: 3 });
      await tick(d.worker({ ai: a.ai }));
      await tick(d.worker({ ai: a.ai }));
      expect(a.calls).toHaveLength(1);
      expect(await jobStates(table)).toEqual({ succeeded: 1 });
      const row = await rowOf(rows[0]);
      expect(row.cells.mail ?? null).toBeNull();
      expect(row.cells.since ?? null).toBeNull();
      expect(row.cells.extra ?? null).toBeNull();
      expect(row.cells).toMatchObject({ site: "https://acme.test", score: 3 });
      expect(row.cell_meta.mail).toMatchObject({ status: "error" });
      expect(row.cell_meta.mail.error).toMatch(/not an email/);
      expect(row.cell_meta.since.error).toMatch(/not a date/);
      expect(row.cell_meta.extra.error).toMatch(/not valid JSON/);
      expect(row.cell_meta.site).toMatchObject({ status: "success" });
      const [run] = await sql`select outcome, response from grid_cell_runs where row_id = ${rows[0]} and column_key = 'profile'`;
      expect(run.outcome).toBe("hit");
      expect((run.response as { rejected: Array<{ field: string }> }).rejected.map((r) => r.field)).toEqual(["mail", "since", "extra"]);
    });

    it("keeps the previous good value when a later answer is rejected, and records only the error", async () => {
      const { actor, table, rows } = await fixture();
      const d = deps();
      await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "E", prompt: "x {{name}}", outputs: [{ key: "mail", type: "email" }, { key: "line", type: "text" }] });
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(d.worker({ ai: answerer({ mail: "ada@acme.test", line: "first" }).ai }));
      expect((await rowOf(rows[0])).cells.mail).toBe("ada@acme.test");
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(d.worker({ ai: answerer({ mail: "not an email", line: "second" }).ai }));
      const row = await rowOf(rows[0]);
      expect(row.cells.mail).toBe("ada@acme.test");
      expect(row.cells.line).toBe("second");
      expect(row.cell_meta.mail).toMatchObject({ status: "error" });
    });

    it("refuses a json answer over the size cap", async () => {
      const { actor, table, rows } = await fixture();
      const d = deps();
      await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "J", prompt: "x {{name}}", outputs: [{ key: "blob", type: "json" }] });
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(d.worker({ ai: answerer({ blob: JSON.stringify({ k: "y".repeat(6000) }) }).ai }));
      const row = await rowOf(rows[0]);
      expect(row.cell_meta.blob.error).toMatch(/longer than/);
      expect(row.cells.blob ?? null).toBeNull();
    });

    it("stores one cell error and pays once when the real provider returns a json answer over 5,000 characters", async () => {
      const { AnthropicAiProvider } = await import("@/contexts/conversations/ai/infrastructure/anthropic-ai-provider");
      const { actor, table, rows } = await fixture();
      const d = deps();
      await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "J", prompt: "x {{name}}", outputs: [{ key: "blob", type: "json" }, { key: "line", type: "text" }] });
      await m.run.requestRun(d.runDeps, actor, table);
      let paid = 0;
      const fetchMock = async () => {
        paid += 1;
        const text = JSON.stringify({ blob: JSON.stringify({ k: "y".repeat(6000) }), line: "ok" });
        return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      };
      const provider = new AnthropicAiProvider({ apiKey: "sk-test-123", fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined });
      const ai = { answer: async (_org: string, input: Parameters<typeof provider.answer>[0]) => ({ ...(await provider.answer(input)), provider: "anthropic", model: "m" }) };
      await tick(d.worker({ ai }));
      await tick(d.worker({ ai }));
      expect(paid).toBe(1);
      expect(await jobStates(table)).toEqual({ succeeded: 1 });
      const row = await rowOf(rows[0]);
      expect(row.cell_meta.blob.error).toMatch(/longer than/);
      expect(row.cells.line).toBe("ok");
    });

    it("keeps a text-only answer as before and a null answer as an empty cell without an error", async () => {
      const { actor, table, rows } = await fixture();
      const d = deps();
      await m.columns.createAiColumns(d.columnDeps, actor, table, { name: "T", prompt: "x {{name}}", outputs: [{ key: "line", type: "text" }, { key: "mail", type: "email" }] });
      await m.run.requestRun(d.runDeps, actor, table);
      await tick(d.worker({ ai: answerer({ line: "hello", mail: null }).ai }));
      const row = await rowOf(rows[0]);
      expect(row.cells.line).toBe("hello");
      expect(row.cell_meta.mail).toMatchObject({ status: "success" });
    });
  });

  describe("editing outputs", () => {
    async function aiTable() {
      const f = await fixture(2);
      const d = deps();
      const created = await m.columns.createAiColumns(d.columnDeps, f.actor, f.table, {
        name: "Profile",
        prompt: "Profile {{name}}",
        outputs: [{ key: "summary", type: "text" }, { key: "score", type: "number" }],
      });
      return { ...f, d, main: created[0], created };
    }

    it("keeps the column of a field whose key stays, adds a column for a new field right after the last output, and edits the prompt", async () => {
      const t = await aiTable();
      const before = await order(t.table);
      const updated = await m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, {
        prompt: "New prompt {{name}} {{company}}",
        outputs: [{ key: "summary", type: "text", description: "one line" }, { key: "score", type: "number" }, { key: "email", type: "email" }],
      });
      expect(updated.config).toMatchObject({ prompt: "New prompt {{name}} {{company}}", outputColumns: { summary: "summary", score: "score", email: "email" } });
      expect(updated.dependsOn).toEqual(["name", "company"]);
      const after = await order(t.table);
      expect(after.map((c) => c.key)).toEqual([...before.map((c) => c.key), "email"]);
      const [email] = await sql`select type, config, depends_on from grid_columns where table_id = ${t.table} and key = 'email'`;
      expect(email.type).toBe("ai_output");
      expect(email.config).toEqual({ sourceColumnKey: t.main.key, outputKey: "email", valueType: "email" });
    });

    it("reuses a column by name when the field key changes, so its values stay", async () => {
      const t = await aiTable();
      await sql`update grid_columns set name = 'Headline' where table_id = ${t.table} and key = 'summary'`;
      await sql`update grid_rows set cells = cells || '{"summary":"kept"}'::jsonb where table_id = ${t.table}`;
      const updated = await m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, {
        outputs: [{ key: "headline", type: "text" }, { key: "score", type: "number" }],
      });
      expect((updated.config.outputColumns as Record<string, string>).headline).toBe("summary");
      const [{ n }] = await sql`select count(*)::int as n from grid_columns where table_id = ${t.table} and type = 'ai_output'`;
      expect(n).toBe(2);
      const [row] = await sql`select cells from grid_rows where id = ${t.rows[0]}`;
      expect(row.cells.summary).toBe("kept");
    });

    it("refuses to retype an output that has values, and writes nothing", async () => {
      const t = await aiTable();
      await sql`update grid_rows set cells = cells || '{"score":5}'::jsonb where id = ${t.rows[0]}`;
      const snapshot = JSON.stringify(await order(t.table));
      await expect(
        m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, { outputs: [{ key: "summary", type: "text" }, { key: "score", type: "email" }, { key: "extra", type: "text" }] }),
      ).rejects.toThrow(/already has values/);
      expect(JSON.stringify(await order(t.table))).toBe(snapshot);
      const [col] = await sql`select config from grid_columns where table_id = ${t.table} and key = 'score'`;
      expect(col.config.valueType).toBe("number");
      const [main] = await sql`select config from grid_columns where id = ${t.main.id}`;
      expect((main.config as { outputs: unknown[] }).outputs).toHaveLength(2);
    });

    it("retypes an output that has no values", async () => {
      const t = await aiTable();
      await m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, { outputs: [{ key: "summary", type: "text" }, { key: "score", type: "email" }] });
      const [col] = await sql`select config from grid_columns where table_id = ${t.table} and key = 'score'`;
      expect(col.config.valueType).toBe("email");
    });

    it("refuses duplicate keys and an empty list, and a prompt that names a missing column", async () => {
      const t = await aiTable();
      await expect(m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, { outputs: [{ key: "a", type: "text" }, { key: "a", type: "text" }] })).rejects.toThrow(/unique/);
      await expect(m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, { outputs: [] })).rejects.toThrow(/at least one/);
      await expect(m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, t.main.id, { prompt: "Use {{gone}}" })).rejects.toThrow(/not a column/);
    });

    it("edits the steps of a waterfall and checks each step against the exposed outputs", async () => {
      const f = await fixture();
      const d = deps();
      await m.providers.createProvider(d.providerDeps, f.actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
      await m.providers.createProvider(d.providerDeps, f.actor, { adapter: "fake", key: "fake2", name: "fake2", credentials: { apiKey: "sk-test-secret-0123456789" } });
      const [main] = await m.columns.createWaterfallColumns(d.columnDeps, f.actor, f.table, { inputs: { fullName: "name", companyDomain: "company" }, steps: [{ providerKey: "fake", actionKey: "find-email" }], selectedOutputs: ["email"] });
      const updated = await m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { steps: [{ providerKey: "fake", actionKey: "find-email" }, { providerKey: "fake2", actionKey: "find-email" }] });
      expect((updated.config as { steps: unknown[] }).steps).toHaveLength(2);
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { steps: [{ providerKey: "nope", actionKey: "find-email" }] })).rejects.toThrow(/not connected/);
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { steps: [] })).rejects.toThrow();
      const [stored] = await sql`select config from grid_columns where id = ${main.id}`;
      expect((stored.config as { steps: unknown[] }).steps).toHaveLength(2);
    });
  });

  describe("editing validation", () => {
    it("stores a trimmed prompt", async () => {
      const f = await fixture();
      const d = deps();
      const [main] = await m.columns.createAiColumns(d.columnDeps, f.actor, f.table, { name: "P", prompt: "x {{name}}", outputs: [{ key: "a", type: "text" }] });
      const updated = await m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { prompt: "  Summarize {{name}}\n " });
      expect(updated.config.prompt).toBe("Summarize {{name}}");
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { prompt: "   " })).rejects.toThrow(/prompt must be 1 to 8,000 characters/);
    });

    it("rejects steps and inputs sent to an AI column, and a prompt sent to a provider column", async () => {
      const f = await fixture();
      const d = deps();
      await m.providers.createProvider(d.providerDeps, f.actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
      const [ai] = await m.columns.createAiColumns(d.columnDeps, f.actor, f.table, { name: "P", prompt: "x {{name}}", outputs: [{ key: "a", type: "text" }] });
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, ai.id, { inputs: { fullName: "name" } })).rejects.toThrow(/no inputs to edit/);
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, ai.id, { steps: [{ providerKey: "fake", actionKey: "find-email" }] })).rejects.toThrow(/Only waterfall/);
      const [wf] = await m.columns.createWaterfallColumns(d.columnDeps, f.actor, f.table, { inputs: { fullName: "name", companyDomain: "company" }, steps: [{ providerKey: "fake", actionKey: "find-email" }], selectedOutputs: ["email"] });
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, wf.id, { prompt: "hi" })).rejects.toThrow(/Only AI columns have a prompt/);
    });

    it("re-checks required inputs when the inputs of an enrichment or waterfall column are edited", async () => {
      const f = await fixture();
      const d = deps();
      await m.providers.createProvider(d.providerDeps, f.actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
      const [wf] = await m.columns.createWaterfallColumns(d.columnDeps, f.actor, f.table, { inputs: { fullName: "name", companyDomain: "company" }, steps: [{ providerKey: "fake", actionKey: "find-email" }], selectedOutputs: ["email"] });
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, wf.id, { inputs: { fullName: "name" } })).rejects.toThrow(/Map the .* input/);
      const [en] = await m.columns.createEnrichmentColumns(d.columnDeps, f.actor, f.table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "company" }, selectedOutputs: ["email"] });
      await expect(m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, en.id, { inputs: {} })).rejects.toThrow(/Map the .* input/);
      const ok = await m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, en.id, { inputs: { fullName: "company", companyDomain: "name" } });
      expect((ok.config as { inputs: Record<string, string> }).inputs).toEqual({ fullName: "company", companyDomain: "name" });
    });
  });

  describe("column limit", () => {
    const fillTo = async (f: { org: string; table: string }, total: number) => {
      const [{ n: have }] = await sql`select count(*)::int as n from grid_columns where table_id = ${f.table}`;
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position)
        select ${f.org}, ${f.table}, 'pad' || n, 'pad' || n, 'text', 100 + n from generate_series(1, ${total - have}::int) n`;
    };
    const count = async (table: string) => (await sql`select count(*)::int as n from grid_columns where table_id = ${table}`)[0].n as number;

    it("refuses to create an AI column whose outputs push the table past 200 columns, and writes nothing", async () => {
      const f = await fixture();
      await fillTo(f, 198);
      const d = deps();
      await expect(
        m.columns.createAiColumns(d.columnDeps, f.actor, f.table, { name: "P", prompt: "x {{name}}", outputs: [{ key: "a", type: "text" }, { key: "b", type: "text" }] }),
      ).rejects.toThrow(/at most 200 columns/);
      expect(await count(f.table)).toBe(198);
      await m.columns.createAiColumns(d.columnDeps, f.actor, f.table, { name: "P", prompt: "x {{name}}", outputs: [{ key: "a", type: "text" }] });
      expect(await count(f.table)).toBe(200);
    });

    it("refuses to add output fields to an AI column past 200 columns", async () => {
      const f = await fixture();
      const d = deps();
      const [main] = await m.columns.createAiColumns(d.columnDeps, f.actor, f.table, { name: "P", prompt: "x {{name}}", outputs: [{ key: "a", type: "text" }] });
      await fillTo(f, 199);
      expect(await count(f.table)).toBe(199);
      await expect(
        m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { outputs: [{ key: "a", type: "text" }, { key: "b", type: "text" }, { key: "c", type: "text" }] }),
      ).rejects.toThrow(/at most 200 columns/);
      expect(await count(f.table)).toBe(199);
      await m.columns.updateRunnableColumn(d.columnDeps, f.actor, f.table, main.id, { outputs: [{ key: "a", type: "text" }, { key: "b", type: "text" }] });
      expect(await count(f.table)).toBe(200);
    });
  });

  describe("placement after a renumber", () => {
    async function squeezed() {
      const f = await fixture();
      const d = deps();
      const gridDeps = m.gridDeps();
      const cols = (await m.columnsUc.listColumns(gridDeps, f.actor, f.table)).columns;
      const anchor = cols[0];
      // 19 inserts into one gap leave it just above the renumber threshold, so the next chain of columns has to renumber.
      for (let n = 0; n < 19; n += 1) await m.columnsUc.createColumn(gridDeps, f.actor, f.table, { name: `Fill${n}`, type: "text", afterColumnId: anchor.id });
      return { ...f, d, anchor };
    }

    it("puts an AI column and its outputs right after the anchor, in order, with no tie", async () => {
      const t = await squeezed();
      const before = await order(t.table);
      const created = await m.columns.createAiColumns(t.d.columnDeps, t.actor, t.table, { name: "Late", prompt: "x {{name}}", outputs: [{ key: "one", type: "text" }, { key: "two", type: "text" }], afterColumnId: t.anchor.id });
      const after = await order(t.table);
      expect(new Set(after.map((c) => c.position)).size).toBe(after.length);
      const keys = after.map((c) => c.key);
      const expected = [before[0].key, ...created.map((c) => c.key), ...before.slice(1).map((c) => c.key)];
      expect(keys).toEqual(expected);
      // The chain needed room, so existing siblings moved.
      const moved = before.filter((b) => after.find((a) => a.key === b.key)!.position !== b.position);
      expect(moved.length).toBeGreaterThan(0);
    });

    it("keeps two concurrent chains contiguous, each in order", async () => {
      const t = await squeezed();
      const make = (name: string) => m.columns.createAiColumns(t.d.columnDeps, t.actor, t.table, { name, prompt: "x {{name}}", outputs: [{ key: `${name.toLowerCase()}a`, type: "text" }, { key: `${name.toLowerCase()}b`, type: "text" }], afterColumnId: t.anchor.id });
      const [first, second] = await Promise.all([make("First"), make("Second")]);
      const after = await order(t.table);
      expect(new Set(after.map((c) => c.position)).size).toBe(after.length);
      const keys = after.map((c) => c.key);
      for (const chain of [first, second]) {
        const start = keys.indexOf(chain[0].key);
        expect(keys.slice(start, start + chain.length)).toEqual(chain.map((c) => c.key));
      }
    });

    it("places new output columns of an edited AI column after its last output once the gap has run out", async () => {
      const t = await squeezed();
      const [main] = await m.columns.createAiColumns(t.d.columnDeps, t.actor, t.table, { name: "Edit", prompt: "x {{name}}", outputs: [{ key: "first", type: "text" }], afterColumnId: t.anchor.id });
      for (let n = 0; n < 19; n += 1) await m.columnsUc.createColumn(m.gridDeps(), t.actor, t.table, { name: `More${n}`, type: "text", afterColumnId: main.id });
      const updated = await m.columns.updateRunnableColumn(t.d.columnDeps, t.actor, t.table, main.id, { outputs: [{ key: "first", type: "text" }, { key: "second", type: "text" }, { key: "third", type: "text" }] });
      const keys = (await order(t.table)).map((c) => c.key);
      const i = keys.indexOf("first");
      expect(keys.slice(i, i + 3)).toEqual(["first", "second", "third"]);
      expect(keys.indexOf(main.key)).toBeLessThan(i);
      expect(Object.keys((updated.config as { outputColumns: object }).outputColumns).sort()).toEqual(["first", "second", "third"]);
    });
  });
});
