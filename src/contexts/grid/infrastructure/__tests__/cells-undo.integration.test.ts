import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("cells compare-and-set and undo", () => {
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");

  async function setup(columns: Array<[string, string]>) {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "cas");
    const actor: Actor = { userId, organizationId: id, role: "member" };
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    const keys: string[] = [];
    for (const [name, type] of columns) keys.push((await columnsUc.createColumn(deps, actor, table.id, { name, type, config: {} })).column.key);
    const rows = await deps.rows.addBlank(id, table.id, 3, 100);
    return { actor, org: id, tableId: table.id, keys, rows };
  }

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const cellsOf = async (rowId: string) => (await sql`select cells from grid_rows where id = ${rowId}`)[0].cells as Record<string, unknown>;

  it("applies a cell whose stored value matches `expected` and returns the coerced value", async () => {
    const { actor, tableId, keys, rows } = await setup([["N", "number"]]);
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "5" }]);
    const result = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "7", expect: { value: 5 } }], { undo: true });
    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual([{ rowId: rows[0].id, columnKey: keys[0], value: 7 }]);
    expect((await cellsOf(rows[0].id))[keys[0]]).toBe(7);
  });

  it("undo skips cells whose column is gone, is a runner column now, or no longer takes the value, and still restores the rest", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["A", "text"], ["N", "number"], ["R", "text"]]);
    const [a, n, r] = keys;
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: a, value: "mine" }]);
    await sql`update grid_columns set type = 'enrichment' where table_id = ${tableId} and key = ${r}`;
    const updates = [
      { rowId: rows[0].id, columnKey: a, value: null, expect: { value: "mine" } },
      { rowId: rows[0].id, columnKey: "deleted_col", value: "x", expect: { value: "y" } },
      { rowId: rows[0].id, columnKey: r, value: "x", expect: { value: "y" } },
      { rowId: rows[0].id, columnKey: n, value: "not a number", expect: { value: 1 } },
    ];
    const result = await rowsUc.editCells(deps, actor, tableId, updates, { undo: true });
    expect(result.applied).toEqual([{ rowId: rows[0].id, columnKey: a, value: null }]);
    expect(result.skipped.map((s) => s.columnKey).sort()).toEqual(["deleted_col", n, r].sort());
    expect((await cellsOf(rows[0].id))[a] ?? null).toBeNull();
    // Only invalid cells: nothing to write, still a normal answer.
    const none = await rowsUc.editCells(deps, actor, tableId, [updates[1]], { undo: true });
    expect(none.applied).toEqual([]);
    expect(none.skipped).toHaveLength(1);
    // A plain edit (not an undo) of the same cells is still refused.
    await expect(rowsUc.editCells(deps, actor, tableId, [updates[1]])).rejects.toThrow(/Unknown column/);
    await expect(rowsUc.editCells(deps, actor, tableId, [updates[2]])).rejects.toThrow(/(is a formula column|is filled by a run)/);
    void org;
  });

  it("skips a cell someone else changed, writes the others and reports the current value", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"], ["B", "text"]]);
    const [a, b] = keys;
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: a, value: "mine" }, { rowId: rows[1].id, columnKey: a, value: "mine" }]);
    // Another member edits row 0 after the first edit.
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: a, value: "theirs" }]);
    const result = await rowsUc.editCells(
      deps,
      actor,
      tableId,
      [
        { rowId: rows[0].id, columnKey: a, value: null, expect: { value: "mine" } },
        { rowId: rows[1].id, columnKey: a, value: null, expect: { value: "mine" } },
        { rowId: rows[0].id, columnKey: b, value: "plain" },
      ],
      { undo: true },
    );
    expect(result.skipped).toEqual([{ rowId: rows[0].id, columnKey: a, current: "theirs" }]);
    expect(result.applied.map((c) => `${c.rowId}:${c.columnKey}`).sort()).toEqual([`${rows[1].id}:${a}`, `${rows[0].id}:${b}`].sort());
    expect(await cellsOf(rows[0].id)).toMatchObject({ [a]: "theirs", [b]: "plain" });
    expect((await cellsOf(rows[1].id))[a]).toBeNull();
  });

  it("treats an empty cell and `expected: null` as equal, and a non-empty one as different", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]]);
    const ok = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "x", expect: { value: null } }]);
    expect(ok.skipped).toEqual([]);
    const no = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "y", expect: { value: null } }]);
    expect(no.skipped).toHaveLength(1);
    expect((await cellsOf(rows[0].id))[keys[0]]).toBe("x");
  });

  it("skips the cells of a row deleted in the meantime instead of failing the request", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["A", "text"]]);
    await deps.rows.delete(org, tableId, [rows[1].id]);
    const result = await rowsUc.editCells(deps, actor, tableId, [
      { rowId: rows[0].id, columnKey: keys[0], value: "kept", expect: { value: null } },
      { rowId: rows[1].id, columnKey: keys[0], value: "lost", expect: { value: null } },
    ]);
    expect(result.skipped).toEqual([{ rowId: rows[1].id, columnKey: keys[0], current: null }]);
    expect((await cellsOf(rows[0].id))[keys[0]]).toBe("kept");
  });

  it("does not let a concurrent write be overwritten when two restores race", async () => {
    const { actor, tableId, keys, rows } = await setup([["A", "text"]]);
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "start" }]);
    const settled = await Promise.all(["one", "two", "three"].map((value) => rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value, expect: { value: "start" } }])));
    // Exactly one restore saw "start" under the row lock.
    expect(settled.filter((r) => r.skipped.length === 0)).toHaveLength(1);
    expect(settled.filter((r) => r.skipped.length === 1)).toHaveLength(2);
  });

  it("an undo write starts no auto-run and marks the runner columns that read the cell stale", async () => {
    const { actor, org, tableId, keys, rows } = await setup([["Note", "text"]]);
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
      values (${org}, ${tableId}, 'summary', 'Summary', 'ai', ${sql.json({ prompt: `Summarize {{${keys[0]}}}` } as never)}, ${[keys[0]]}, 99, true)`;
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "before" }]);
    await sql`delete from grid_jobs where table_id = ${tableId}`;
    const typed = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "after" }]);
    expect(typed.queued).toBe(1);
    await sql`delete from grid_jobs where table_id = ${tableId}`;

    const undone = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: "before", expect: { value: "after" } }], { undo: true });
    expect(undone.queued).toBe(0);
    expect(await sql`select 1 from grid_jobs where table_id = ${tableId}`).toHaveLength(0);
    const meta = (await sql`select cell_meta from grid_rows where id = ${rows[0].id}`)[0].cell_meta as Record<string, { status?: string }>;
    expect(meta.summary?.status).toBe("stale");
    // Only the restored row is marked.
    const other = (await sql`select cell_meta from grid_rows where id = ${rows[1].id}`)[0].cell_meta as Record<string, { status?: string }>;
    expect(other.summary).toBeUndefined();
  });

  it("recalculates formulas after an undo", async () => {
    const { actor, tableId, keys, rows } = await setup([["N", "number"]]);
    await columnsUc.createColumn(deps, actor, tableId, { name: "Double", type: "formula", config: { expression: `{{${keys[0]}}} * 2` } });
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: 2 }]);
    await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: 10 }]);
    const result = await rowsUc.editCells(deps, actor, tableId, [{ rowId: rows[0].id, columnKey: keys[0], value: 2, expect: { value: 10 } }], { undo: true });
    const formulaKey = (await columnsUc.listColumns(deps, actor, tableId)).columns.find((c) => c.type === "formula")!.key;
    expect(result.rows[0].cells[formulaKey]).toBe(4);
  });
});
