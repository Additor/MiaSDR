import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChangeCursor } from "@/contexts/grid/domain/change-cursor";
import type { GridDeps } from "@/contexts/grid/application/ports";
import type { Actor } from "@/shared/errors";

/**
 * Times RowStore.changesSince on a 50,000 row, 20 column table.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres. Env: BENCH_ROWS, BENCH_REPS.
 */
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const ROWS = Number(process.env.BENCH_ROWS ?? 50_000);
const COLS = 20;
const REPS = Number(process.env.BENCH_REPS ?? 30);
const PAGE = 500;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

describeDb("changesSince benchmark", () => {
  const sql = postgres(url ?? "", { max: 4, onnotice: () => undefined });
  let deps: GridDeps;
  let org = "";
  let tableId = "";
  const keys: string[] = [];
  const results: Array<{ scenario: string; p50: number; p95: number }> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATABASE_SSL = "disable";
    process.env.APP_URL = "http://localhost:3000";
    const secret = "x".repeat(40);
    process.env.BETTER_AUTH_SECRET = secret;
    process.env.INTEGRATION_CREDENTIALS_KEY = secret;
    process.env.UNSUBSCRIBE_SECRET = secret;
    deps = (await import("@/contexts/grid/infrastructure/composition")).gridDeps();
    const structure = await import("@/contexts/grid/application/structure-management");
    const columns = await import("@/contexts/grid/application/column-management");
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('bench', ${`bench-${tag}`}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('B', ${`${tag}@bench.test`}) returning id`;
    org = id;
    const actor: Actor = { userId, organizationId: id, role: "member" };
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    tableId = table.id;
    for (let i = 0; i < COLS; i += 1) keys.push((await columns.createColumn(deps, actor, tableId, { name: `C${i}`, type: "text", config: {} })).column.key);
    const cells = Object.fromEntries(keys.map((k) => [k, "some cell value for the benchmark"]));
    await sql`delete from grid_rows where table_id = ${tableId}`;
    await sql`insert into grid_rows (organization_id, table_id, position, cells, cell_meta)
      select ${org}, ${tableId}, g, ${sql.json(cells as never)}, '{}'::jsonb from generate_series(1, ${ROWS}) g`;
    await sql`analyze grid_rows`;
  });

  afterAll(async () => {
    await sql`delete from organizations where id = ${org}`.catch(() => undefined);
    await sql.end();
    console.table(results);
  });

  async function measure(scenario: string, changed: number, drain: boolean) {
    const times: number[] = [];
    for (let rep = 0; rep < REPS + 3; rep += 1) {
      const start = await deps.rows.currentCursor(org, tableId);
      if (changed > 0) {
        await sql`update grid_rows set cells = cells || '{"bench":"x"}'::jsonb
          where id in (select id from grid_rows where table_id = ${tableId} order by random() limit ${changed})`;
      }
      const t0 = performance.now();
      let cursor = start;
      let seen = 0;
      for (;;) {
        const page = await deps.rows.changesSince(org, tableId, cursor, PAGE);
        seen += page.rows.length;
        cursor = page.cursor;
        if (!drain || !page.hasMore) break;
      }
      const ms = performance.now() - t0;
      if (rep >= 3) times.push(ms); // first three rounds warm the pool and plan cache
      // A transaction held open on the shared server lowers the horizon, so extra rows can come back; never fewer.
      expect(seen).toBeGreaterThanOrEqual(drain ? changed : Math.min(changed, PAGE));
    }
    results.push({ scenario, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1) });
  }

  it("0 changed rows", () => measure("0 changed (one call)", 0, false));
  it("100 changed rows", () => measure("100 changed (one call)", 100, false));
  it("5,000 changed rows, first page", () => measure("5000 changed (first page of 500)", 5000, false));
  it("5,000 changed rows, full drain", () => measure("5000 changed (drain, 10 calls)", 5000, true));

  it("explains the feed query", async () => {
    const start = await deps.rows.currentCursor(org, tableId);
    const version = parseChangeCursor(start)?.version ?? 0;
    const plan = await sql.unsafe(
      `explain (analyze, buffers) select * from grid_rows where organization_id = $1 and table_id = $2 and (version > $3 or ((xmin::text::bigint - 1 + 4294967296) % 4294967296) < 2147483648) order by version limit 501`,
      [org, tableId, version] as never,
    );
    console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
  });
});
