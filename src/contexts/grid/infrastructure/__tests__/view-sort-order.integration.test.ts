import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { SortSpec } from "../../domain/view-query";
import { gridOrg } from "./grid-test-kit";

/** Ten expression sorts whose early keys tie: position and id end the order, so the same query gives the same rows. */
describeDb("ten sorts over tied values", () => {
  const sql = testSql();
  const orgs: TestOrg[] = [];
  const columns = [
    ...["t1", "t2", "t3", "t4", "t5"].map((key) => ({ key, type: "text" })),
    ...["n1", "n2", "n3", "n4", "n5"].map((key) => ({ key, type: "number" })),
  ];
  const sorts: SortSpec[] = columns.map((c, i) => ({ columnKey: c.key, direction: i % 2 === 0 ? "asc" : "desc" }));
  let org = "";
  let table = "";
  let store: typeof import("../drizzle-row-store").drizzleRowStore;

  useTestEnv();
  beforeAll(async () => {
    store = (await import("../drizzle-row-store")).drizzleRowStore;
    org = (await gridOrg(sql, orgs, "owner", "Sort")).organizationId;
    const [{ id: workbook }] = await sql`insert into grid_workbooks (organization_id, name) values (${org}, 'wb') returning id`;
    [{ id: table }] = await sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${org}, ${workbook}, 't', 1) returning id`;
    for (const [i, c] of columns.entries()) {
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${org}, ${table}, ${c.key}, ${c.key}, ${c.type}, ${i + 1})`;
    }
    // Every row repeats the same few values, so all ten sort keys tie across many rows. A tenth of the cells are empty.
    await sql`
      insert into grid_rows (organization_id, table_id, position, cells)
      select ${org}, ${table}, g % 50,
        jsonb_strip_nulls(jsonb_build_object(
          't1', 'g' || (g % 2), 't2', 'h' || (g % 3), 't3', 'i', 't4', case when g % 10 = 0 then null else 'j' end, 't5', 'k',
          'n1', g % 2, 'n2', 1, 'n3', case when g % 10 = 1 then null else 2 end, 'n4', 3, 'n5', 4))
      from generate_series(1, 500) as g`;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("returns the same rows in the same order for the same query, on the first and the last page", async () => {
    const first = await store.list(org, table, { limit: 200, offset: 0, query: { sorts }, columns });
    const again = await store.list(org, table, { limit: 200, offset: 0, query: { sorts }, columns });
    expect(first).toHaveLength(200);
    expect(again.map((r) => r.id)).toEqual(first.map((r) => r.id));
    const last = await store.list(org, table, { limit: 200, offset: 300, query: { sorts }, columns });
    const lastAgain = await store.list(org, table, { limit: 200, offset: 300, query: { sorts }, columns });
    expect(last).toHaveLength(200);
    expect(lastAgain.map((r) => r.id)).toEqual(last.map((r) => r.id));
  });

  it("pages through every row exactly once", async () => {
    const pages = await Promise.all([0, 200, 400].map((offset) => store.list(org, table, { limit: 200, offset, query: { sorts }, columns })));
    const ids = pages.flat().map((r) => r.id);
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
  });
});
