import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";
import type { GridDeps } from "../../application/ports";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";

describeDb("paste block", () => {
  const sql = testSql({ max: 6 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");
  let pasteUc: typeof import("../../application/paste-management");

  async function setup(columns: Array<[string, string]>, rowCount: number) {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, "member");
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    // A new table starts with a seed column and a blank row; the tests want to count their own.
    await sql`delete from grid_rows where table_id = ${table.id}`;
    await sql`delete from grid_columns where table_id = ${table.id}`;
    const keys: string[] = [];
    for (const [name, type] of columns) keys.push((await columnsUc.createColumn(deps, actor, table.id, { name, type, config: {} })).column.key);
    const rows = rowCount > 0 ? await deps.rows.addBlank(id, table.id, rowCount, 100_000) : [];
    return { actor, org: id, tableId: table.id, keys, rows };
  }

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
    pasteUc = await import("../../application/paste-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const rowCount = async (tableId: string) => Number((await sql`select count(*) from grid_rows where table_id = ${tableId}`)[0].count);
  const columnCount = async (tableId: string) => Number((await sql`select count(*) from grid_columns where table_id = ${tableId}`)[0].count);
  const tableOrder = async (tableId: string) => (await sql`select id, cells from grid_rows where table_id = ${tableId} order by position, id`) as unknown as Array<{ id: string; cells: Record<string, unknown> }>;

  it("fills the rows after the anchor in table order and creates the missing rows", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]], 5);
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[3].id, columnKeys: [keys[0]], values: [["a"], ["b"], ["c"], ["d"]] });
    expect(result.addedRows).toBe(2);
    const order = await tableOrder(tableId);
    expect(order).toHaveLength(7);
    expect(order.map((r) => r.cells[keys[0]] ?? null)).toEqual([null, null, null, "a", "b", "c", "d"]);
    expect(result.applied.map((a) => [a.value, a.before])).toEqual([["a", null], ["b", null], ["c", null], ["d", null]]);
    expect(result.rows.map((r) => r.id)).toEqual(order.slice(3).map((r) => r.id));
  });

  it("reaches rows the client never loaded without creating any", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]], 300);
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[250].id, columnKeys: [keys[0]], values: [["x"], ["y"], ["z"]] });
    expect(result.addedRows).toBe(0);
    const order = await tableOrder(tableId);
    expect(order).toHaveLength(300);
    expect(order.slice(250, 253).map((r) => r.cells[keys[0]])).toEqual(["x", "y", "z"]);
    expect(order[253].cells[keys[0]]).toBeUndefined();
  });

  it("creates text columns right after the last target column, in order", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"], ["B", "text"]], 2);
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], newColumns: 2, values: [["1", "p", "q"], ["2", "r", "s"]] });
    expect(result.createdColumns).toHaveLength(2);
    const ordered = (await columnsUc.listColumns(deps, actor, tableId)).columns.map((c) => c.key);
    expect(ordered).toEqual([keys[0], result.createdColumns[0].key, result.createdColumns[1].key, keys[1]]);
    const order = await tableOrder(tableId);
    expect(order[1].cells).toMatchObject({ [keys[0]]: "2", [result.createdColumns[0].key]: "r", [result.createdColumns[1].key]: "s" });
    expect(result.createdColumns.every((c) => c.type === "text")).toBe(true);
  });

  it("keeps new columns ordered when the gap before the neighbour has run out", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["A", "text"], ["B", "text"]], 1);
    await sql`update grid_columns set position = 1 where table_id = ${tableId} and key = ${keys[0]}`;
    await sql`update grid_columns set position = 1.0000001 where table_id = ${tableId} and key = ${keys[1]}`;
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], newColumns: 3, values: [["1", "a", "b", "c"]] });
    const positions = (await sql`select key, position from grid_columns where organization_id = ${org} and table_id = ${tableId} order by position`) as unknown as Array<{ key: string; position: number }>;
    expect(positions.map((p) => p.key)).toEqual([keys[0], ...result.createdColumns.map((c) => c.key), keys[1]]);
    expect(new Set(positions.map((p) => p.position)).size).toBe(5);
  });

  it("writes nothing for 5,001 cells or 1,001 rows", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"], ["B", "text"]], 3);
    const wide = Array.from({ length: 556 }, () => Array.from({ length: 9 }, () => "x"));
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0], keys[1]], newColumns: 7, values: wide })).rejects.toThrow(/5,000 cells/);
    const tall = Array.from({ length: 1_001 }, () => ["x"]);
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: tall })).rejects.toBeInstanceOf(ValidationError);
    expect(await rowCount(tableId)).toBe(3);
    expect(await columnCount(tableId)).toBe(2);
    expect((await tableOrder(tableId)).every((r) => Object.keys(r.cells).length === 0)).toBe(true);
    // The limits themselves are allowed: 5,000 cells in 1,000 rows of five.
    const ok = await setup([["A", "text"]], 1);
    const five = Array.from({ length: 1_000 }, () => ["x"]);
    const done = await pasteUc.pasteCells(deps, ok.actor, ok.tableId, { anchorRowId: ok.rows[0].id, columnKeys: [ok.keys[0]], values: five });
    expect(done.addedRows).toBe(999);
  });

  it("rolls back created rows and columns when the write fails", async () => {
    const { org, tableId, keys, rows } = await setup([["A", "text"]], 2);
    await expect(
      deps.rows.paste(org, tableId, { anchorRowId: rows[1].id, height: 4, columnKeys: [keys[0]], newColumns: 1, limits: { maxRows: 100, maxColumns: 10, maxNewRows: 10 } }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await rowCount(tableId)).toBe(2);
    expect(await columnCount(tableId)).toBe(1);
    // A cell write that fails after the rows exist also rolls everything back.
    await expect(
      deps.rows.paste(org, tableId, { anchorRowId: rows[1].id, height: 3, columnKeys: [keys[0]], newColumns: 0, limits: { maxRows: 100, maxColumns: 10, maxNewRows: 10 } }, () => ({
        cells: [{ rowIndex: 0, columnKey: keys[0], value: "ok" }, { rowIndex: 1, columnKey: keys[0], value: { toJSON: () => { throw new Error("bad json"); } } }],
      })),
    ).rejects.toThrow();
    expect(await rowCount(tableId)).toBe(2);
    expect((await tableOrder(tableId))[1].cells[keys[0]]).toBeUndefined();
  });

  it("refuses to grow a filtered, sorted or searched view, and writes nothing", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]], 2);
    await sql`update grid_tables set view = ${sql.json({ filters: { conjunction: "and", conditions: [{ columnKey: keys[0], operator: "notEmpty" }] } } as never)} where id = ${tableId}`;
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["a"], ["b"], ["c"]] })).rejects.toThrow(/filtered, sorted or searched/);
    await sql`update grid_tables set view = ${sql.json({ sorts: [{ columnKey: keys[0], direction: "asc" }] } as never)} where id = ${tableId}`;
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["a"]] })).rejects.toThrow(/filtered, sorted or searched/);
    await sql`update grid_tables set view = '{}'::jsonb where id = ${tableId}`;
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["a"]], search: "x" })).rejects.toThrow(/filtered, sorted or searched/);
    expect(await rowCount(tableId)).toBe(2);
    // A muted condition does not narrow the table, so it does not block the paste.
    await sql`update grid_tables set view = ${sql.json({ filters: { conjunction: "and", conditions: [{ columnKey: keys[0], operator: "notEmpty", disabled: true }] } } as never)} where id = ${tableId}`;
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["a"], ["b"], ["c"]] })).resolves.toMatchObject({ addedRows: 1 });
  });

  it("skips runner columns and values a column refuses, and reports both", async () => {
    const { actor, tableId, keys, rows } = await setup([["Name", "text"], ["Score", "number"]], 2);
    const formula = await columnsUc.createColumn(deps, actor, tableId, { name: "Double", type: "formula", config: { expression: `{{${keys[1]}}} * 2` } });
    const result = await pasteUc.pasteCells(deps, actor, tableId, {
      anchorRowId: rows[0].id,
      columnKeys: [keys[0], keys[1], formula.column.key],
      values: [["Ann", "7", "1"], ["x".repeat(60_000), "abc", "2"]],
    });
    expect(result.skippedRunner).toBe(2);
    expect(result.invalidCount).toBe(1);
    expect(result.invalid[0]).toMatchObject({ rowIndex: 1, columnKey: keys[0] });
    const order = await tableOrder(tableId);
    expect(order[0].cells).toMatchObject({ [keys[0]]: "Ann", [keys[1]]: 7, [formula.column.key]: 14 });
    // The refused cell stays empty, its neighbour is written (a number column keeps text it cannot parse as typed).
    expect(order[1].cells[keys[0]]).toBeUndefined();
    expect(order[1].cells[keys[1]]).toBe("abc");
  });

  it("answers a gone anchor row or a removed column with a clear error", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["A", "text"]], 2);
    await deps.rows.delete(org, tableId, [rows[0].id]);
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["a"]] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[1].id, columnKeys: ["gone"], values: [["a"]] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("queues the auto-run columns that read pasted cells and recalculates formulas", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["Note", "text"]], 2);
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
      values (${org}, ${tableId}, 'summary', 'Summary', 'ai', ${sql.json({ prompt: `Summarize {{${keys[0]}}}` } as never)}, ${[keys[0]]}, 99, true)`;
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["one"], ["two"]] });
    expect(result.queued).toBe(2);
  });

  it("returns what a later undo needs: the cell before and after, created rows empty", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]], 1);
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "old" }]);
    const result = await pasteUc.pasteCells(deps, actor, tableId, { anchorRowId: rows[0].id, columnKeys: [keys[0]], values: [["new1"], ["new2"]] });
    expect(result.applied).toEqual([
      { rowId: rows[0].id, columnKey: keys[0], before: "old", value: "new1" },
      { rowId: result.rows[1].id, columnKey: keys[0], before: null, value: "new2" },
    ]);
  });
});
