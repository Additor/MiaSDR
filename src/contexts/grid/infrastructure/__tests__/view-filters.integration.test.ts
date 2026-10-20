import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg, type GridOrg } from "./grid-test-kit";
import type { GridDeps } from "../../application/ports";
import type { FilterCondition, FilterGroup, SortSpec } from "../../domain/view-query";

/** The rows a saved view returns, for nested filter groups, muted conditions and number columns holding stray text. */
describeDb("view filters and sorts against stored rows", () => {
  const sql = testSql({ max: 4 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let rowsUc: typeof import("../../application/row-management");
  let owner: GridOrg;
  let tableId: string;
  let name: string;
  let city: string;
  let score: string;

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    rowsUc = await import("../../application/row-management");
    const columnsUc = await import("../../application/column-management");
    owner = await gridOrg(sql, orgs, "owner");
    const { table } = await structure.createWorkbook(deps, owner.actor, { name: "W", firstTableName: "T" });
    tableId = table.id;
    await sql`delete from grid_rows where table_id = ${tableId}`;
    const column = async (label: string, type: string) => (await columnsUc.createColumn(deps, owner.actor, tableId, { name: label, type, config: {} })).column.key;
    name = await column("Name", "text");
    city = await column("City", "text");
    score = await column("Score", "number");
    const seed: Array<[string, string, string | null]> = [
      ["ann", "Seoul", "1"],
      ["bea", "Busan", "5"],
      ["cy", "Seoul", "9"],
      ["dee", "Daegu", "12"],
      ["eve", "Busan", null],
    ];
    const rows = await deps.rows.addBlank(owner.organizationId, tableId, seed.length, 100);
    await rowsUc.editCells(
      deps,
      owner.actor,
      tableId,
      rows.flatMap((row, i) => {
        const [n, c, s] = seed[i];
        return [{ rowId: row.id, columnKey: name, value: n }, { rowId: row.id, columnKey: city, value: c }, ...(s === null ? [] : [{ rowId: row.id, columnKey: score, value: s }])];
      }),
    );
    // A stored view can outlive a type change, so a number column may still hold text from before.
    await sql`update grid_rows set cells = cells || jsonb_build_object(${score}::text, 'n/a') where id = ${rows[4].id}`;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const eq = (columnKey: string, value: string, disabled?: boolean): FilterCondition => ({ columnKey, operator: "eq", value, ...(disabled ? { disabled } : {}) });
  const cmp = (operator: FilterCondition["operator"], value: string): FilterCondition => ({ columnKey: score, operator, value });
  const group = (conjunction: "and" | "or", ...conditions: FilterGroup["conditions"]): FilterGroup => ({ conjunction, conditions });

  async function namesFor(view: { filters?: FilterGroup; sorts?: SortSpec[] }) {
    await structure.updateTable(deps, owner.actor, tableId, { view });
    return (await rowsUc.getTablePage(deps, owner.actor, tableId)).rows.map((r) => r.cells[name]);
  }

  it("applies an or group nested inside an and group", async () => {
    expect(await namesFor({ filters: group("and", cmp("gte", "5"), group("or", eq(city, "Seoul"), eq(city, "Busan"))) })).toEqual(["bea", "cy"]);
  });

  it("applies an and group nested inside an or group", async () => {
    expect(await namesFor({ filters: group("or", eq(name, "dee"), group("and", eq(city, "Seoul"), cmp("lt", "5"))) })).toEqual(["ann", "dee"]);
  });

  it("applies groups three levels deep", async () => {
    expect(await namesFor({ filters: group("and", group("or", group("and", eq(name, "ann"), eq(city, "Seoul")), cmp("gt", "10"))) })).toEqual(["ann", "dee"]);
  });

  it("keeps the other branch of an or group when one branch is muted", async () => {
    expect(await namesFor({ filters: group("or", eq(name, "ann", true), eq(city, "Busan")) })).toEqual(["bea", "eve"]);
  });

  it("drops a nested group whose conditions are all muted and keeps the rest of the filter", async () => {
    expect(await namesFor({ filters: group("and", eq(city, "Seoul"), group("or", eq(name, "bea", true), eq(name, "dee", true))) })).toEqual(["ann", "cy"]);
  });

  it("returns every row when every condition is muted", async () => {
    expect(await namesFor({ filters: group("and", eq(name, "ann", true), eq(city, "Seoul", true)) })).toEqual(["ann", "bea", "cy", "dee", "eve"]);
  });

  it("compares a number column as numbers and skips a text cell in it", async () => {
    expect(await namesFor({ filters: group("and", cmp("gt", "5")) })).toEqual(["cy", "dee"]);
  });

  it("sorts a number column numerically with a text cell last instead of failing the query", async () => {
    expect(await namesFor({ sorts: [{ columnKey: score, direction: "asc" }] })).toEqual(["ann", "bea", "cy", "dee", "eve"]);
    expect(await namesFor({ sorts: [{ columnKey: score, direction: "desc" }] })).toEqual(["dee", "cy", "bea", "ann", "eve"]);
  });
});
