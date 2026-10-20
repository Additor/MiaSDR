import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Fake provider, no network. */

describeDb("partial grid runs: first N rows and one cell", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  let m: {
    providers: typeof import("../../application/enrichment-providers");
    columns: typeof import("../../application/enrichment-columns");
    run: typeof import("../../application/enrichment-run");
    adapters: typeof import("../enrichment-adapters");
    pstore: typeof import("../enrichment-provider-store");
    rstore: typeof import("../enrichment-run-store");
    crypto: typeof import("@/contexts/integrations/infrastructure/credential-crypto");
  };

  function deps() {
    const urlPolicy = { allowedHosts: [] as string[] };
    const adapters = m.adapters.createAdapterRegistry({ policy: urlPolicy, fake: new m.adapters.FakeEnrichmentProvider() });
    const cipher = { encrypt: (p: string) => m.crypto.encryptCredential(p, "x".repeat(40)), decrypt: (e: string) => m.crypto.decryptCredential(e, "x".repeat(40)) };
    return {
      providerDeps: { providers: m.pstore.drizzleProviderStore, cipher, adapters, urlPolicy, allowFake: true },
      runDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters, now: () => new Date() },
      columnDeps: { store: m.rstore.drizzleGridRunStore, providers: m.pstore.drizzleProviderStore, adapters },
    };
  }

  /** A table of `rowCount` rows with a find-email enrichment column (source key `findEmail`) and an `email` output column. */
  async function setup(rowCount: number) {
    const d = deps();
    const { organizationId: org, actor } = await gridOrg(sql, orgs, "owner", "Grid");
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, key] of ["name", "domain", "about"].entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, ${key}, ${key}, 'text', ${i + 1})`;
    }
    const values = Array.from({ length: rowCount }, (_, i) => ({ organization_id: org, table_id: table, position: i + 1, cells: sql.json({ name: `Person${i + 1} Test`, domain: "acme.com" } as never) }));
    for (let i = 0; i < values.length; i += 500) await sql`insert into grid_rows ${sql(values.slice(i, i + 500))}`;
    await m.providers.createProvider(d.providerDeps, actor, { adapter: "fake", key: "fake", name: "fake", credentials: { apiKey: "sk-test-secret-0123456789" } });
    await m.columns.createEnrichmentColumns(d.columnDeps, actor, table, { providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] });
    return { d, org, actor, table };
  }

  /** Positions of the rows that have a queued job, ascending. */
  const queuedPositions = async (table: string) =>
    (await sql`select r.position from grid_jobs j join grid_rows r on r.id = j.row_id where j.table_id = ${table} order by r.position`).map((r) => r.position as number);
  const fill = (table: string, from: number, to: number) => sql`update grid_rows set cells = cells || '{"findEmail":"known@acme.com"}'::jsonb where table_id = ${table} and position between ${from} and ${to}`;
  const rowAt = async (table: string, position: number) => (await sql`select id from grid_rows where table_id = ${table} and position = ${position}`)[0].id as string;

  useTestEnv();

  beforeAll(async () => {
    m = {
      providers: await import("../../application/enrichment-providers"),
      columns: await import("../../application/enrichment-columns"),
      run: await import("../../application/enrichment-run"),
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

  it("queues only the first N rows in table order", async () => {
    const { d, actor, table } = await setup(40);
    const report = await m.run.requestRun(d.runDeps, actor, table, { firstN: 10 });
    expect(report).toMatchObject({ queued: 10, rows: 10 });
    expect(await queuedPositions(table)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("counts the first N after the empty-cells filter, so filled rows do not use up the count", async () => {
    const { d, actor, table } = await setup(40);
    await fill(table, 1, 10);
    const report = await m.run.requestRun(d.runDeps, actor, table, { firstN: 5, onlyEmpty: true });
    expect(report).toMatchObject({ queued: 5, rows: 5 });
    expect(await queuedPositions(table)).toEqual([11, 12, 13, 14, 15]);
  });

  it("takes filled rows into the count when the run overwrites them", async () => {
    const { d, actor, table } = await setup(40);
    await fill(table, 1, 10);
    await m.run.requestRun(d.runDeps, actor, table, { firstN: 5, onlyEmpty: false });
    expect(await queuedPositions(table)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reaches past the row limit to find empty cells, because the limit refuses and never truncates", async () => {
    const { d, actor, table } = await setup(1200);
    await fill(table, 1, 1100);
    const report = await m.run.requestRun(d.runDeps, actor, table, { firstN: 5, onlyEmpty: true });
    expect(report.queued).toBe(5);
    expect(await queuedPositions(table)).toEqual([1101, 1102, 1103, 1104, 1105]);
  }, 60_000);

  it("keeps refusing a run without firstN when the table is over maxRows", async () => {
    const { d, actor, table } = await setup(30);
    await expect(m.run.requestRun(d.runDeps, actor, table, { maxRows: 10 })).rejects.toThrow(/more rows than the limit of 10/);
    expect(await queuedPositions(table)).toEqual([]);
    const ok = await m.run.requestRun(d.runDeps, actor, table, { maxRows: 10, firstN: 10 });
    expect(ok.queued).toBe(10);
  });

  it("refuses a firstN above maxRows and a firstN that is not a whole number from 1", async () => {
    const { d, actor, table } = await setup(30);
    await expect(m.run.requestRun(d.runDeps, actor, table, { maxRows: 5, firstN: 6 })).rejects.toThrow(/row limit/);
    for (const bad of [0, -1, 2.5, 10_001]) await expect(m.run.requestRun(d.runDeps, actor, table, { firstN: bad })).rejects.toThrow(/firstN/);
    expect(await queuedPositions(table)).toEqual([]);
  });

  it("applies firstN inside a row selection, in table order and not in selection order", async () => {
    const { d, actor, table } = await setup(20);
    const ids = [await rowAt(table, 9), await rowAt(table, 5), await rowAt(table, 7), await rowAt(table, 6)];
    await m.run.requestRun(d.runDeps, actor, table, { rowIds: ids, firstN: 3 });
    expect(await queuedPositions(table)).toEqual([5, 6, 7]);
  });

  it("charges the cost cap for the first N rows only", async () => {
    const { d, actor, table } = await setup(30);
    // The fake provider prices a cell at 1 cent: 30 rows would be 30 cents, 3 rows are 3.
    await expect(m.run.requestRun(d.runDeps, actor, table, { maxCostCents: 3 })).rejects.toThrow(/worst-case cost/);
    const report = await m.run.requestRun(d.runDeps, actor, table, { firstN: 3, maxCostCents: 3 });
    expect(report).toMatchObject({ queued: 3, worstCaseCostCents: 3 });
  });

  it("returns an empty report when no row has anything to run", async () => {
    const { d, actor, table } = await setup(5);
    await fill(table, 1, 5);
    await expect(m.run.requestRun(d.runDeps, actor, table, { firstN: 3, onlyEmpty: true })).resolves.toMatchObject({ queued: 0, rows: 0 });
  });

  it("runs one cell: the source column and one row id queue exactly one job, even when the cell is filled", async () => {
    const { d, actor, table } = await setup(10);
    await fill(table, 1, 10);
    const rowId = await rowAt(table, 4);
    const report = await m.run.requestRun(d.runDeps, actor, table, { columnKey: "findEmail", rowIds: [rowId], onlyEmpty: false, maxRows: 1 });
    expect(report).toMatchObject({ queued: 1, rows: 1, columns: ["findEmail"] });
    expect(await queuedPositions(table)).toEqual([4]);
    // Pressing it twice leaves one job, because a cell has one job.
    await m.run.requestRun(d.runDeps, actor, table, { columnKey: "findEmail", rowIds: [rowId, rowId], onlyEmpty: false, maxRows: 1 });
    expect(await queuedPositions(table)).toEqual([4]);
  });
});
