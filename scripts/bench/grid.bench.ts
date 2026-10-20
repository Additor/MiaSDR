import { afterAll, beforeAll, expect, it } from "vitest";
import type { SortSpec } from "@/contexts/grid/domain/view-query";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

/**
 * Times two grid paths that read or write a whole table. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 * Env: BENCH_ROWS (default 50,000).
 *
 * Ten expression sorts have no index, so the query reads and sorts every row. On Postgres 17 in Docker on a laptop the
 * first page took 135 to 170 ms and the last page 537 ms at 50,000 rows.
 */
const ROWS = Number(process.env.BENCH_ROWS ?? 50_000);

describeDb("grid benchmark", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  const results: Array<{ scenario: string; ms: number }> = [];

  async function table(org: string, columns: Array<{ key: string; type: string }>) {
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    const [{ id }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, c] of columns.entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${id}, ${c.key}, ${c.key}, ${c.type}, ${i + 1})`;
    }
    return id as string;
  }

  useTestEnv();
  beforeAll(async () => {
    orgs.push(await createTestOrg(sql, "Bench"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
    console.table(results);
  });

  it("ten sorts, first and last page", async () => {
    const store = (await import("@/contexts/grid/infrastructure/drizzle-row-store")).drizzleRowStore;
    const org = orgs[0].organizationId;
    const columns = [
      ...["t1", "t2", "t3", "t4", "t5"].map((key) => ({ key, type: "text" })),
      ...["n1", "n2", "n3", "n4", "n5"].map((key) => ({ key, type: "number" })),
    ];
    const id = await table(org, columns);
    await sql`
      insert into grid_rows (organization_id, table_id, position, cells)
      select ${org}, ${id}, g,
        jsonb_strip_nulls(jsonb_build_object(
          't1', 'g' || (g % 7), 't2', 'h' || (g % 11), 't3', 'i' || (g % 13), 't4', case when g % 10 = 0 then null else 'j' || (g % 17) end, 't5', 'k' || (g % 19),
          'n1', g % 5, 'n2', g % 9, 'n3', case when g % 10 = 1 then null else g % 23 end, 'n4', g % 29, 'n5', (g * 7919) % 50021))
      from generate_series(1, ${ROWS}::int) as g`;
    const sorts: SortSpec[] = columns.map((c, i) => ({ columnKey: c.key, direction: i % 2 === 0 ? "asc" : "desc" }));
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      expect(await store.list(org, id, { limit: 200, offset: 0, query: { sorts }, columns })).toHaveLength(200);
      results.push({ scenario: `sort first page, run ${run + 1}`, ms: Math.round(performance.now() - t0) });
    }
    const t0 = performance.now();
    expect(await store.list(org, id, { limit: 200, offset: ROWS - 200, query: { sorts }, columns })).toHaveLength(200);
    results.push({ scenario: "sort last page", ms: Math.round(performance.now() - t0) });
  });

  it("formula recalculation of every row", async () => {
    const recalc = await import("@/contexts/grid/application/formula-recalc");
    const deps = (await import("@/contexts/grid/infrastructure/composition")).gridDeps();
    const org = orgs[0].organizationId;
    const id = await table(org, [{ key: "name", type: "text" }]);
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position, config, depends_on, auto_run) values (${org}, ${id}, 'up', 'up', 'formula', 2, ${sql.json({ expression: "UPPER({{name}})" })}, ${["name"]}, true)`;
    await sql`insert into grid_rows (organization_id, table_id, position, cells) select ${org}, ${id}, g, jsonb_build_object('name', 'n' || g) from generate_series(1, ${ROWS}::int) as g`;
    await sql`analyze grid_rows`;
    const t0 = performance.now();
    expect(await recalc.recalculateFormula(deps, org, id, "up")).toBe(ROWS);
    results.push({ scenario: `recalculate ${ROWS} rows`, ms: Math.round(performance.now() - t0) });
  });
});
