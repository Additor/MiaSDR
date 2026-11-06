import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { issuedCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The route, then the worker with the fake provider. A test that stopped at the queue would pass whatever the worker spent,
 * so each run counts `grid_cell_runs.cost_cents` and the provider's calls.
 */
describeDb("MCP agent enrichment", () => {
  useTestEnv({ GRID_PROVIDER: "fake", GRID_HTTP_ALLOWED_HOSTS: "api.vendor.test" });
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  let POST: (request: Request) => Promise<Response>;
  let org: TestOrg;
  let owner: Actor;
  let agent: McpCaller;
  let tokens: typeof import("@/contexts/agent-access/application/mcp-tokens");
  let tokenDeps: import("@/contexts/agent-access/application/mcp-tokens").McpTokenDeps;
  let m: {
    columns: typeof import("@/contexts/grid/enrichment/application/enrichment-columns");
    providers: typeof import("@/contexts/grid/enrichment/application/enrichment-providers");
    composition: typeof import("@/contexts/grid/enrichment/infrastructure/enrichment-composition");
    worker: typeof import("@/contexts/grid/enrichment/application/enrichment-worker");
  };

  const codeOf = (result: { structured: Record<string, unknown> }) => (result.structured.error as { code?: string } | undefined)?.code;
  const reserved = async () => (await sql<{ amount: number }[]>`select amount from mcp_agent_usage where organization_id = ${org.organizationId} and kind = 'spend_cents'`)[0]?.amount ?? 0;
  const spent = async (table: string) => Number((await sql<{ sum: string | null }[]>`select sum(cost_cents) as sum from grid_cell_runs where table_id = ${table}`)[0].sum ?? 0);
  const queuedJobs = async (table: string) => (await sql`select 1 from grid_jobs where table_id = ${table} and status in ('queued', 'waiting')`).length;

  /** Runs the worker until the queue is empty. */
  async function drain(table: string) {
    const job = m.worker.createGridRunJob(m.composition.gridWorkerDeps({ concurrency: 4 }));
    for (let i = 0; i < 20 && (await queuedJobs(table)) > 0; i++) await job.run({ deadline: Date.now() + 30_000, now: () => new Date() });
    expect(await queuedJobs(table)).toBe(0);
  }

  async function provider(cents: number) {
    const key = `fake`;
    await sql`delete from grid_providers where organization_id = ${org.organizationId}`;
    await m.providers.createProvider(m.composition.gridProviderDeps(), owner, { adapter: "fake", key, name: "Fake", credentials: { apiKey: "sk-test-secret-0123456789" }, defaultCostCents: cents });
  }

  async function table(rowCount: number) {
    const [{ id: workbook }] = await sql<{ id: string }[]>`insert into grid_workbooks (organization_id, name) values (${org.organizationId}, ${`wb ${randomBytes(3).toString("hex")}`}) returning id`;
    const [{ id }] = await sql<{ id: string }[]>`insert into grid_tables (organization_id, workbook_id, name, position) values (${org.organizationId}, ${workbook}, 't', 1) returning id`;
    for (const [i, key] of ["name", "domain"].entries()) await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org.organizationId}, ${id}, ${key}, ${key}, 'text', ${i + 1})`;
    await sql`insert into grid_rows (organization_id, table_id, position, cells) select ${org.organizationId}, ${id}, g, ${sql.json({ name: "Ada Lovelace", domain: "acme.com" } as never)} from generate_series(1, ${rowCount}) g`;
    // Every row asks the same, so reuse would answer from an earlier call. These tests count each call.
    await m.columns.createEnrichmentColumns(m.composition.gridColumnDeps(), owner, id, { providerKey: "fake", actionKey: "find-work-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"], reuseDays: 0 });
    const rows = (await sql<{ id: string }[]>`select id from grid_rows where table_id = ${id} order by position`).map((r) => r.id);
    return { id, rows };
  }

  /** A second provider column that reads the email the first one finds, and runs by itself. */
  const addVerifier = (tableId: string) => m.columns.createEnrichmentColumns(m.composition.gridColumnDeps(), owner, tableId, { providerKey: "fake", actionKey: "verify-email", inputs: { email: "workEmail" }, selectedOutputs: ["status"], autoRun: true, reuseDays: 0 } as never);

  const dry = (tableId: string, extra: Record<string, unknown> = { firstN: 2 }) => agent.tool("run_enrichment", { tableId, columnKey: "findWorkEmail", dryRun: true, ...extra });
  const run = (tableId: string, actionToken: string, extra: Record<string, unknown> = { firstN: 2 }) => agent.tool("run_enrichment", { tableId, columnKey: "findWorkEmail", actionToken, ...extra });
  const tokenFor = async (tableId: string, extra?: Record<string, unknown>) => {
    const seen = await dry(tableId, extra);
    expect(seen.isError, seen.text).toBe(false);
    expect(seen.structured.refusals, seen.text).toEqual([]);
    return seen.structured.actionToken as string;
  };
  const issue = async (extras: Array<"spend" | "irreversible">) => issuedCaller(POST, await tokens.createMcpToken(tokenDeps, owner, { name: `Agent ${randomBytes(3).toString("hex")}`, access: "write", extras }));

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    tokens = await import("@/contexts/agent-access/application/mcp-tokens");
    tokenDeps = (await import("@/contexts/agent-access/infrastructure/mcp-composition")).mcpTokenDeps();
    m = {
      columns: await import("@/contexts/grid/enrichment/application/enrichment-columns"),
      providers: await import("@/contexts/grid/enrichment/application/enrichment-providers"),
      composition: await import("@/contexts/grid/enrichment/infrastructure/enrichment-composition"),
      worker: await import("@/contexts/grid/enrichment/application/enrichment-worker"),
    };
    org = await createTestOrg(sql, "Agent enrichment");
    orgs.push(org);
    owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    await tokens.updateMcpSettings(tokenDeps, owner, { enabled: true });
  });

  beforeEach(async () => {
    await sql`delete from mcp_agent_usage where organization_id = ${org.organizationId}`;
    await sql`update mcp_tokens set revoked_at = now() where organization_id = ${org.organizationId} and revoked_at is null`;
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 0 });
    m.composition.fakeGridProvider().calls = [];
    m.composition.fakeGridProvider().handler = null;
    await provider(30);
    agent = await issue(["spend"]);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("shows tables and columns to a read token, with cells as outside data", async () => {
    const t = await table(1);
    const reader = issuedCaller(POST, await tokens.createMcpToken(tokenDeps, owner, { name: "Reader" }));
    const listed = await reader.tool("list_tables");
    expect(listed.isError, listed.text).toBe(false);
    expect((listed.structured.tables as Array<{ tableId: string }>).map((x) => x.tableId)).toContain(t.id);
    const got = await reader.tool("get_table", { tableId: t.id });
    expect(got.isError, got.text).toBe(false);
    expect((got.structured.columns as Array<{ key: string; runnable: boolean }>).find((c) => c.key === "findWorkEmail")?.runnable).toBe(true);
    const [row] = got.structured.rows as Array<{ cells: Record<string, string> }>;
    expect(row.cells.name).toMatch(/^<untrusted_field_/);
    const names = ((await callMcp(POST, { era: "modern", token: reader.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name);
    expect(names).not.toContain("run_enrichment");
  });

  it("offers run_enrichment only to a token with the scope while the enrichment limit is above 0", async () => {
    const names = async (caller: McpCaller) => ((await callMcp(POST, { era: "modern", token: caller.token, method: "tools/list" })).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name);
    expect(await names(agent)).toContain("run_enrichment");
    expect(await names(await issue([]))).not.toContain("run_enrichment");
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 10 });
    expect(await names(agent)).not.toContain("run_enrichment");
  });

  it("queues and reserves nothing on a dry run, and stays out of the spend bucket", async () => {
    const t = await table(3);
    const seen = await dry(t.id);
    expect(seen.structured).toMatchObject({ dryRun: true, queued: 0, cells: 2, rows: 2, worstCaseCostCents: 60 });
    expect(await queuedJobs(t.id)).toBe(0);
    expect(await reserved()).toBe(0);
    expect(await sql`select 1 from mcp_rate_limits where token_id = ${agent.tokenId} and bucket = 'spend'`).toHaveLength(0);
  });

  it("runs the cells, spends no more than it reserved, and calls the provider as often as it said", async () => {
    const t = await table(3);
    const result = await run(t.id, await tokenFor(t.id));
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ queued: 2, worstCaseCostCents: 60 });
    expect(await reserved()).toBe(60);
    await drain(t.id);
    expect(await spent(t.id)).toBeLessThanOrEqual(60);
    expect(m.composition.fakeGridProvider().calls).toHaveLength(2);
    const [audit] = await sql<{ meta: { reservedCents: number; via?: { tokenId: string } } }[]>`select meta from audit_log where organization_id = ${org.organizationId} and action = 'grid.agent_run' and entity_id = ${t.id}`;
    expect(audit.meta).toMatchObject({ reservedCents: 60, via: { tokenId: agent.tokenId } });
  });

  it("rounds a price with a fraction of a cent up against the limit", async () => {
    await provider(0.5);
    const t = await table(3);
    await sql`update grid_providers set default_cost_cents = 12.5 where organization_id = ${org.organizationId} and key = 'fake'`;
    const result = await run(t.id, await tokenFor(t.id, { firstN: 3 }), { firstN: 3 });
    expect(result.isError, result.text).toBe(false);
    expect(await reserved()).toBe(38);
  });

  it("never pays again for a cell that has a value", async () => {
    const t = await table(2);
    await run(t.id, await tokenFor(t.id));
    await drain(t.id);
    const calls = m.composition.fakeGridProvider().calls.length;
    const again = await dry(t.id);
    expect(again.structured).toMatchObject({ cells: 0, worstCaseCostCents: 0 });
    const before = await reserved();
    expect((await run(t.id, again.structured.actionToken as string)).structured).toMatchObject({ queued: 0 });
    expect(await reserved()).toBe(before);
    expect(m.composition.fakeGridProvider().calls).toHaveLength(calls);
  });

  it("refuses an input the strict schema does not know, such as fresh or onlyEmpty", async () => {
    const t = await table(1);
    for (const extra of [{ fresh: true }, { onlyEmpty: false }]) {
      const answer = await callMcp(POST, { era: "modern", token: agent.token, method: "tools/call", params: { name: "run_enrichment", arguments: { tableId: t.id, columnKey: "findWorkEmail", firstN: 1, dryRun: true, ...extra } } });
      const body = answer.body as { error?: unknown; result?: { isError?: boolean } };
      expect(body.error ?? body.result?.isError).toBeTruthy();
    }
    expect(codeOf(await agent.tool("run_enrichment", { tableId: t.id, columnKey: "findWorkEmail", dryRun: true }))).toBe("validation");
    expect(codeOf(await agent.tool("run_enrichment", { tableId: t.id, columnKey: "findWorkEmail", firstN: 1, rowIds: t.rows, dryRun: true }))).toBe("validation");
  });

  it("counts the auto-run columns a run sets off, and they fit what it reserved", async () => {
    const t = await table(2);
    await addVerifier(t.id);
    const seen = await dry(t.id);
    expect(seen.structured).toMatchObject({ cells: 2, worstCaseCostCents: 120 });
    expect((seen.structured.dependents as string[]).length).toBe(1);
    const result = await run(t.id, seen.structured.actionToken as string);
    expect(result.isError, result.text).toBe(false);
    expect(await reserved()).toBe(120);
    await drain(t.id);
    expect(m.composition.fakeGridProvider().calls.length).toBe(4);
    expect(await spent(t.id)).toBeLessThanOrEqual(120);
  });

  it("refuses an AI column, and a provider column that sets one off", async () => {
    const t = await table(1);
    const addAi = (key: string, dependsOn: string[], autoRun: boolean) =>
      sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
          values (${org.organizationId}, ${t.id}, ${key}, ${key}, 'ai', ${sql.json({ prompt: "Hi {{name}}", outputs: [{ key: "line", type: "text" }], outputColumns: {} } as never)}, ${dependsOn}, 50, ${autoRun})`;
    await addAi("opener", ["name"], false);
    expect(await agent.tool("run_enrichment", { tableId: t.id, columnKey: "opener", firstN: 1, dryRun: true })).toMatchObject({ structured: { refusals: [expect.objectContaining({ code: "agent_ai_column" })], actionToken: null } });
    await addAi("summary", ["workEmail"], true);
    expect((await dry(t.id)).structured.refusals).toEqual([expect.objectContaining({ code: "agent_ai_column" })]);
    expect(codeOf(await run(t.id, "at1.anything"))).toBe("agent_ai_column");
    expect(await queuedJobs(t.id)).toBe(0);
    expect(await reserved()).toBe(0);
  });

  /** A provider with no price at all: the generic HTTP adapter's actions cost 0 unless an admin says otherwise. */
  const unpriced = () =>
    m.providers.createProvider(m.composition.gridProviderDeps(), owner, {
      adapter: "http",
      key: "free",
      name: "Free",
      baseUrl: "https://api.vendor.test",
      credentials: { apiKey: "sk-test-secret-0123456789" },
      config: { actions: { find: { name: "Find", path: "/find/{{fullName}}", inputs: [{ key: "fullName", name: "Name", type: "text" }], outputs: { title: "title" }, primaryOutput: "title" } } },
    });

  it("refuses a column with no price, on the column or on one it sets off", async () => {
    await unpriced();
    const t = await table(1);
    await m.columns.createEnrichmentColumns(m.composition.gridColumnDeps(), owner, t.id, { providerKey: "free", actionKey: "find", inputs: { fullName: "name" }, selectedOutputs: ["title"] });
    const [{ key }] = await sql<{ key: string }[]>`select key from grid_columns where table_id = ${t.id} and type = 'enrichment' and key <> 'findWorkEmail'`;
    const seen = await agent.tool("run_enrichment", { tableId: t.id, columnKey: key, firstN: 1, dryRun: true });
    expect(seen.structured.refusals).toEqual([expect.objectContaining({ code: "agent_price_unset", message: expect.stringContaining("Free") })]);
    expect(codeOf(await agent.tool("run_enrichment", { tableId: t.id, columnKey: key, firstN: 1, actionToken: "at1.x" }))).toBe("agent_price_unset");
    expect(await queuedJobs(t.id)).toBe(0);

    // The priced column sets the free one off once it reads what the first one finds.
    await sql`update grid_columns set depends_on = ${["workEmail"]}, auto_run = true where table_id = ${t.id} and key = ${key}`;
    expect((await dry(t.id, { firstN: 1 })).structured.refusals).toEqual([expect.objectContaining({ code: "agent_price_unset" })]);
  });

  it("refuses a free step inside a paid waterfall", async () => {
    await unpriced();
    const t = await table(1);
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position)
              values (${org.organizationId}, ${t.id}, 'fall', 'Fall', 'waterfall', ${sql.json({ inputs: { fullName: "name", companyDomain: "domain" }, steps: [{ providerKey: "fake", actionKey: "find-work-email" }, { providerKey: "free", actionKey: "find" }] } as never)}, ${["name", "domain"]}, 60)`;
    const seen = await agent.tool("run_enrichment", { tableId: t.id, columnKey: "fall", firstN: 1, dryRun: true });
    expect((seen.structured.refusals as Array<{ code: string; message: string }>)[0]).toMatchObject({ code: "agent_price_unset", message: expect.stringContaining("Free") });
  });

  it("goes stale when a row, a price or the auto-run switch changes", async () => {
    const t = await table(3);
    const token = await tokenFor(t.id, { rowIds: t.rows });
    await sql`update grid_providers set default_cost_cents = 31 where organization_id = ${org.organizationId} and key = 'fake'`;
    expect(codeOf(await run(t.id, token, { rowIds: t.rows }))).toBe("action_token_stale");
    await sql`update grid_providers set default_cost_cents = 30 where organization_id = ${org.organizationId} and key = 'fake'`;

    const fewer = await tokenFor(t.id, { rowIds: t.rows.slice(0, 2) });
    expect(codeOf(await run(t.id, fewer, { rowIds: t.rows }))).toBe("action_token_stale");

    const beforeRow = await tokenFor(t.id, { firstN: 3 });
    await sql`delete from grid_rows where id = ${t.rows[2]}`;
    expect(codeOf(await run(t.id, beforeRow, { firstN: 3 }))).toBe("action_token_stale");

    const beforeSwitch = await tokenFor(t.id);
    await sql`update grid_tables set auto_run = false where id = ${t.id}`;
    expect(codeOf(await run(t.id, beforeSwitch))).toBe("action_token_stale");
    expect(await reserved()).toBe(0);
  });

  it("stops at the limit, one of two at the boundary, and gives back what a refusal took", async () => {
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSpendCentsPerDay: 30 });
    const [a, b] = [await table(1), await table(1)];
    const [ta, tb] = [await tokenFor(a.id, { firstN: 1 }), await tokenFor(b.id, { firstN: 1 })];
    const results = await Promise.all([run(a.id, ta, { firstN: 1 }), run(b.id, tb, { firstN: 1 })]);
    expect(results.map((result) => codeOf(result)).filter((code) => code === "agent_spend_cap")).toHaveLength(1);
    expect(await reserved()).toBe(30);
    expect((await queuedJobs(a.id)) + (await queuedJobs(b.id))).toBe(1);
  });

  it("makes a limit save wait for a reservation, and a reservation after it sees the new limit", async () => {
    const t = await table(2);
    const token = await tokenFor(t.id);
    const lock = await sql.reserve();
    try {
      await lock`begin`;
      await lock.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`agent-send:${org.organizationId}`]);
      const running = run(t.id, token);
      await waitForLockWaiters(sql, 1, 10_000, "%pg_advisory_xact_lock%");
      await lock`update channel_settings set values = values || ${lock.json({ agentSpendCentsPerDay: 10 })} where organization_id = ${org.organizationId} and channel = 'mcp'`;
      await lock`commit`;
      expect(codeOf(await running)).toBe("agent_spend_cap");
    } finally {
      lock.release();
    }
    expect(await queuedJobs(t.id)).toBe(0);
  });

  it("records what a provider charged above the estimate, and lets it stand", async () => {
    const t = await table(1);
    m.composition.fakeGridProvider().handler = () => ({ outcome: "hit", primary: "a@acme.com", outputs: { email: "a@acme.com", confidence: 90 }, costCents: 500, request: {}, response: {} });
    await run(t.id, await tokenFor(t.id, { firstN: 1 }), { firstN: 1 });
    await drain(t.id);
    expect(await reserved()).toBe(30);
    expect(await spent(t.id)).toBe(500);
  });

  it("runs an auto-run column a person added after the run, outside what the agent reserved", async () => {
    const t = await table(1);
    const fake = m.composition.fakeGridProvider();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The first cell waits mid-call, so the column lands while the run is under way.
    fake.handler = async (call) => {
      if (call.action === "find-work-email") await gate;
      return { outcome: "hit", primary: "a@acme.com", outputs: call.action === "find-work-email" ? { email: "a@acme.com", confidence: 90 } : { status: "valid" }, request: {}, response: {} };
    };
    await run(t.id, await tokenFor(t.id, { firstN: 1 }), { firstN: 1 });
    const draining = drain(t.id);
    await vi.waitFor(() => expect(fake.calls.length).toBe(1), { timeout: 10_000 });
    await addVerifier(t.id);
    release();
    await draining;
    await vi.waitFor(async () => {
      if ((await queuedJobs(t.id)) > 0) await drain(t.id);
      expect(fake.calls.map((c) => c.action).sort()).toEqual(["find-work-email", "verify-email"]);
    }, { timeout: 10_000 });
    expect(await reserved()).toBe(30);
  });

  it("keeps queued cells running after the limit drops to 0, within what was reserved", async () => {
    const t = await table(2);
    await run(t.id, await tokenFor(t.id));
    await tokens.updateMcpSettings(tokenDeps, owner, { agentSpendCentsPerDay: 0 });
    await drain(t.id);
    expect(m.composition.fakeGridProvider().calls).toHaveLength(2);
    expect(await spent(t.id)).toBeLessThanOrEqual(60);
  });

  it("stops queued cells, marks them as stopped by an agent, and spends nothing on them", async () => {
    const t = await table(3);
    await run(t.id, await tokenFor(t.id, { firstN: 3 }), { firstN: 3 });
    const writer = await issue([]);
    const stopped = await writer.tool("stop_enrichment", { tableId: t.id });
    expect(stopped.isError, stopped.text).toBe(false);
    expect(stopped.structured.stopped).toBe(3);
    expect(await queuedJobs(t.id)).toBe(0);
    const rows = await sql<{ response: { reason: string } }[]>`select response from grid_cell_runs where table_id = ${t.id} and outcome = 'cancelled'`;
    expect(rows.map((r) => r.response.reason)).toEqual(["Stopped by an agent.", "Stopped by an agent.", "Stopped by an agent."]);
    await drain(t.id);
    expect(m.composition.fakeGridProvider().calls).toHaveLength(0);
    // What it reserved stays spent for the day: the plan keeps the limit simple and errs early.
    expect(await reserved()).toBe(90);
  });

  it("lets a person's run go on as before, with no reservation", async () => {
    const { requestRun } = await import("@/contexts/grid/enrichment/application/enrichment-run");
    const t = await table(1);
    await requestRun(m.composition.gridRunDeps(), owner, t.id, { columnKey: "findWorkEmail" });
    expect(await reserved()).toBe(0);
    const [row] = await sql<{ response: unknown }[]>`select count(*) as response from grid_jobs where table_id = ${t.id}`;
    expect(Number(row.response)).toBe(1);
  });
});
