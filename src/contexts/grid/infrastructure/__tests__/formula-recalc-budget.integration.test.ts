import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Recalculation budget and the stale marker it leaves. */
describeDb("formula recalculation budget", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  let recalc: typeof import("../../application/formula-recalc");
  let deps: import("../../application/ports").GridDeps;

  async function fixture(rowCount: number) {
    const org = (await gridOrg(sql, orgs, "owner")).organizationId;
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, 'name', 'name', 'text', 1)`;
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position, config, depends_on, auto_run) values (${org}, ${table}, 'up', 'up', 'formula', 2, ${sql.json({ expression: "UPPER({{name}})" })}, ${["name"]}, true)`;
    await sql`insert into grid_rows (organization_id, table_id, position, cells) select ${org}, ${table}, g, jsonb_build_object('name', 'n' || g) from generate_series(1, ${rowCount}::int) as g`;
    return { org, table };
  }
  const stats = async (table: string) => {
    const [r] = await sql`select count(*) filter (where cells ? 'up')::int as filled, count(*) filter (where cell_meta -> 'up' ->> 'status' = 'stale')::int as stale, count(*)::int as total from grid_rows where table_id = ${table}`;
    return r as { filled: number; stale: number; total: number };
  };

  useTestEnv();
  beforeAll(async () => {
    recalc = await import("../../application/formula-recalc");
    deps = (await import("../composition")).gridDeps();
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("stops at the budget with the finished rows saved, marks the column stale with the reason, and a later run completes it and clears the marker", async () => {
    const { org, table } = await fixture(1500);
    let now = 0;
    // The clock moves 10 s per read, so the budget is spent after the first batch.
    const clock = () => (now += 10_000);
    await expect(recalc.recalculateFormulas(deps, org, table, { columnKeys: ["up"] }, { budgetMs: 15_000, clock })).rejects.toBeInstanceOf(recalc.RecalcBudgetError);
    const partial = await stats(table);
    expect(partial.filled).toBeGreaterThan(0);
    expect(partial.filled).toBeLessThan(1500);

    // The quiet path (an edit, a save) marks the rows it did not reach; the rows it finished stay clean.
    const fresh = await fixture(1500);
    now = 0;
    await recalc.recalculateFormulasQuietly(deps, fresh.org, fresh.table, { columnKeys: ["up"] }, { budgetMs: 15_000, clock });
    const marked = await stats(fresh.table);
    expect(marked.filled).toBeGreaterThan(0);
    expect(marked.stale).toBe(1500 - marked.filled);
    const [meta] = await sql`select cell_meta -> 'up' ->> 'error' as error from grid_rows where table_id = ${fresh.table} and cell_meta -> 'up' ->> 'status' = 'stale' limit 1`;
    expect(meta.error).toMatch(/Recalculation stopped after 15 seconds/);
    expect(meta.error).toMatch(/Recalculate/);

    // Running it again finishes the rest, skips the finished rows, and clears every marker.
    await recalc.recalculateFormula(deps, fresh.org, fresh.table, "up");
    expect(await stats(fresh.table)).toEqual({ filled: 1500, stale: 0, total: 1500 });
  }, 60_000);

  it("markStale marks only the given rows with the reason, leaves the others clean, and a rerun clears the marker", async () => {
    const { org, table } = await fixture(5);
    const ids = (await sql`select id from grid_rows where table_id = ${table} order by position`).map((r) => r.id as string);
    expect(await deps.rows.markStale(org, table, ["up"], "connection reset", ids.slice(0, 2))).toBe(2);
    const marked = await sql`select id, cell_meta -> 'up' as meta from grid_rows where table_id = ${table} order by position`;
    expect(marked.map((r) => r.meta)).toEqual([{ status: "stale", error: "connection reset" }, { status: "stale", error: "connection reset" }, null, null, null]);
    // Rows already stale are not counted again.
    expect(await deps.rows.markStale(org, table, ["up"], "connection reset")).toBe(3);
    expect((await stats(table)).stale).toBe(5);
    await recalc.recalculateFormula(deps, org, table, "up");
    expect(await stats(table)).toEqual({ filled: 5, stale: 0, total: 5 });
  });
});
