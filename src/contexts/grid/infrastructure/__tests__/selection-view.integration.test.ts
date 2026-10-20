import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";
import type { GridDeps } from "../../application/ports";

/** "Select all matching rows" asks for `/selection?search=` only. The server resolves the member's merged view itself. */
describeDb("select all matching rows follows the view", () => {
  const sql = testSql({ max: 4 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let rowsUc: typeof import("../../application/row-management");

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    rowsUc = await import("../../application/row-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  async function setup() {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, "owner");
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    await sql`delete from grid_rows where table_id = ${table.id}`;
    const key = (await sql`select key from grid_columns where table_id = ${table.id} limit 1`)[0].key as string;
    const rows = await deps.rows.addBlank(id, table.id, 6, 1000);
    const names = ["Ann", "Bob", "Cat", "Abe", "Dee", "Al"];
    await rowsUc.editCells(deps, actor, table.id, rows.map((r, i) => ({ rowId: r.id, columnKey: key, value: names[i] })));
    return { actor, tableId: table.id, key, rows };
  }

  it("returns only the rows the default view's filter keeps", async () => {
    const { actor, tableId, key, rows } = await setup();
    await sql`update grid_tables set view = ${sql.json({ filters: { conjunction: "and", conditions: [{ columnKey: key, operator: "contains", value: "A" }] } } as never)} where id = ${tableId}`;
    const picked = await rowsUc.selectRows(deps, actor, tableId, {});
    expect(picked.rowIds).toEqual([rows[0].id, rows[2].id, rows[3].id, rows[5].id]);
  });

  it("follows the member's own filter and combines it with the search", async () => {
    const { actor, tableId, key, rows } = await setup();
    await structure.saveMyView(deps, actor, tableId, { filters: { conjunction: "and", conditions: [{ columnKey: key, operator: "notEmpty" }, { columnKey: key, operator: "neq", value: "Bob" }] } });
    expect((await rowsUc.selectRows(deps, actor, tableId, {})).rowIds).toHaveLength(5);
    const withSearch = await rowsUc.selectRows(deps, actor, tableId, { search: "Ab" });
    expect(withSearch.rowIds).toEqual([rows[3].id]);
  });

  it("ignores a muted condition and returns the whole table", async () => {
    const { actor, tableId, key } = await setup();
    await sql`update grid_tables set view = ${sql.json({ filters: { conjunction: "and", conditions: [{ columnKey: key, operator: "eq", value: "Ann", disabled: true }] } } as never)} where id = ${tableId}`;
    expect((await rowsUc.selectRows(deps, actor, tableId, {})).rowIds).toHaveLength(6);
  });
});
