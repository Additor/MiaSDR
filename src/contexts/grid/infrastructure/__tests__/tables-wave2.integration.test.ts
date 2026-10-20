import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";
import type { GridDeps } from "../../application/ports";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";

/** Add rows, duplicate column, edit description and move table. */
describeDb("grid rows, column duplicate and table move", () => {
  const sql = testSql({ max: 6 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");

  async function org() {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, "owner");
    return { id, actor };
  }

  async function workbook(actor: Actor, name = "W") {
    const { workbook: w, table } = await structure.createWorkbook(deps, actor, { name, firstTableName: "T" });
    return { workbookId: w.id, tableId: table.id };
  }

  const tabs = async (workbookId: string) => (await sql`select id, name, position from grid_tables where workbook_id = ${workbookId} order by position, id`).map((r) => ({ id: r.id as string, name: r.name as string, position: Number(r.position) }));
  const columnKeys = async (tableId: string) => (await sql`select key from grid_columns where table_id = ${tableId} order by position, id`).map((r) => r.key as string);
  const cellsOf = async (tableId: string) => (await sql`select cells from grid_rows where table_id = ${tableId} order by position, id`).map((r) => r.cells as Record<string, unknown>);

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

  describe("add rows", () => {
    it("adds 1 and 1,000 rows at the end, and refuses 0, 1,001, decimals and text", async () => {
      const { actor } = await org();
      const { tableId } = await workbook(actor);
      await rowsUc.addRows(deps, actor, tableId, 1);
      expect((await rowsUc.addRows(deps, actor, tableId, 1_000)).rows).toHaveLength(1_000);
      const [{ n }] = await sql`select count(*)::int as n from grid_rows where table_id = ${tableId}`;
      expect(n).toBe(1 + 1 + 1_000);
      const positions = (await sql`select position from grid_rows where table_id = ${tableId} order by position`).map((r) => Number(r.position));
      expect(new Set(positions).size).toBe(positions.length);
      for (const bad of [0, 1_001, -5, 2.5, "ten", NaN]) await expect(rowsUc.addRows(deps, actor, tableId, bad)).rejects.toBeInstanceOf(ValidationError);
      const [{ n: after }] = await sql`select count(*)::int as n from grid_rows where table_id = ${tableId}`;
      expect(after).toBe(n);
    });

    it("stops at the table's row cap with a conflict and writes nothing", async () => {
      const { id, actor } = await org();
      const { tableId } = await workbook(actor);
      await sql`
        insert into grid_rows (organization_id, table_id, position, cells, cell_meta)
        select ${id}, ${tableId}, g + 10, '{}'::jsonb, '{}'::jsonb from generate_series(1, 49500) g`;
      await expect(rowsUc.addRows(deps, actor, tableId, 1_000)).rejects.toBeInstanceOf(ConflictError);
      expect((await rowsUc.addRows(deps, actor, tableId, 499)).rows).toHaveLength(499);
    }, 30_000);
  });

  describe("duplicate column", () => {
    it("copies a data column's values, type and config next to the original", async () => {
      const { actor } = await org();
      const { tableId } = await workbook(actor);
      const text = (await columnsUc.createColumn(deps, actor, tableId, { name: "Company", type: "text" })).column;
      const after = (await columnsUc.createColumn(deps, actor, tableId, { name: "After", type: "text" })).column;
      const rows = [...(await rowsUc.getTablePage(deps, actor, tableId)).rows, ...(await deps.rows.addBlank(actor.organizationId, tableId, 2, 100))];
      await deps.rows.applyEdits(actor.organizationId, tableId, [
        { rowId: rows[0].id, set: { [text.key]: "Acme" } },
        { rowId: rows[1].id, set: { [text.key]: "Globex 회사" } },
      ]);

      const { column: copy } = await columnsUc.createColumn(deps, actor, tableId, { name: "Company (copy)", type: text.type, config: text.config, afterColumnId: text.id, copyValuesFrom: text.key });
      expect(copy.type).toBe("text");
      expect(copy.key).not.toBe(text.key);
      const order = await columnKeys(tableId);
      expect(order.indexOf(copy.key)).toBe(order.indexOf(text.key) + 1);
      expect(order.indexOf(after.key)).toBeGreaterThan(order.indexOf(copy.key));
      const cells = await cellsOf(tableId);
      expect(cells.map((c) => c[copy.key] ?? null)).toEqual(["Acme", "Globex 회사", null]);
      expect(cells.map((c) => c[text.key] ?? null)).toEqual(["Acme", "Globex 회사", null]);
      // The copy is its own column: editing it leaves the original alone.
      await deps.rows.applyEdits(actor.organizationId, tableId, [{ rowId: rows[0].id, set: { [copy.key]: "Changed" } }]);
      expect((await cellsOf(tableId))[0][text.key]).toBe("Acme");
    });

    it("copies a formula's expression and calculates its own values", async () => {
      const { actor } = await org();
      const { tableId } = await workbook(actor);
      const score = (await columnsUc.createColumn(deps, actor, tableId, { name: "Score", type: "number" })).column;
      const rows = await rowsUc.getTablePage(deps, actor, tableId).then((p) => p.rows);
      await deps.rows.applyEdits(actor.organizationId, tableId, [{ rowId: rows[0].id, set: { [score.key]: 21 } }]);
      const double = (await columnsUc.createColumn(deps, actor, tableId, { name: "Double", type: "formula", config: { expression: `{{${score.key}}} * 2` } })).column;
      const { column: copy } = await columnsUc.createColumn(deps, actor, tableId, { name: "Double (copy)", type: "formula", config: double.config, afterColumnId: double.id });
      expect(copy.type).toBe("formula");
      expect(copy.dependsOn).toEqual([score.key]);
      expect(Number((await cellsOf(tableId))[0][copy.key])).toBe(42);
    });

    it("refuses to copy values from or into a runner or formula column", async () => {
      const { actor } = await org();
      const { tableId } = await workbook(actor);
      const text = (await columnsUc.createColumn(deps, actor, tableId, { name: "Name", type: "text" })).column;
      const formula = (await columnsUc.createColumn(deps, actor, tableId, { name: "F", type: "formula", config: { expression: `UPPER({{${text.key}}})` } })).column;
      await expect(columnsUc.createColumn(deps, actor, tableId, { name: "F copy", type: "text", copyValuesFrom: formula.key })).rejects.toThrow(/data column/);
      await expect(columnsUc.createColumn(deps, actor, tableId, { name: "AI copy", type: "ai", config: {} })).rejects.toThrow(/own setup dialog/);
    });
  });

  describe("description and move", () => {
    it("sets and clears a table description", async () => {
      const { actor } = await org();
      const { tableId } = await workbook(actor);
      expect((await structure.updateTable(deps, actor, tableId, { description: "  Leads from May  " })).table.description).toBe("Leads from May");
      expect((await structure.updateTable(deps, actor, tableId, { description: "   " })).table.description).toBeNull();
      await expect(structure.updateTable(deps, actor, tableId, { description: 5 })).rejects.toBeInstanceOf(ValidationError);
    });

    it("moves a table to the end of another workbook and keeps its columns and rows", async () => {
      const { actor } = await org();
      const a = await workbook(actor, "A");
      const b = await workbook(actor, "B");
      const { table: second } = await structure.createTable(deps, actor, { workbookId: a.workbookId, name: "Second" });
      const col = (await columnsUc.createColumn(deps, actor, second.id, { name: "Note", type: "text" })).column;
      await deps.rows.addBlank(actor.organizationId, second.id, 3, 100);
      await structure.duplicateTable(deps, actor, b.tableId);

      const before = await tabs(b.workbookId);
      const { table } = await structure.updateTable(deps, actor, second.id, { description: "Moved note", workbookId: b.workbookId });
      expect(table.workbookId).toBe(b.workbookId);
      expect(table.description).toBe("Moved note");
      const after = await tabs(b.workbookId);
      expect(after.map((t) => t.id)).toEqual([...before.map((t) => t.id), second.id]);
      expect(after[after.length - 1].position).toBeGreaterThan(before[before.length - 1].position);
      expect((await tabs(a.workbookId)).map((t) => t.id)).toEqual([a.tableId]);
      expect(await columnKeys(second.id)).toContain(col.key);
      expect((await cellsOf(second.id)).length).toBe(4);
    });

    it("appends after a destination whose tabs were squeezed together without a tie", async () => {
      const { actor } = await org();
      const a = await workbook(actor, "A");
      const b = await workbook(actor, "B");
      for (let n = 0; n < 55; n += 1) await structure.duplicateTable(deps, actor, b.tableId);
      await sql`update grid_tables set position = 1 + (random() * 1e-9) where workbook_id = ${b.workbookId}`;
      const { table: moving } = await structure.createTable(deps, actor, { workbookId: a.workbookId, name: "Mover" });
      await structure.updateTable(deps, actor, moving.id, { workbookId: b.workbookId });
      const after = await tabs(b.workbookId);
      expect(after).toHaveLength(57);
      expect(new Set(after.map((t) => t.position)).size).toBe(57);
      expect(after[after.length - 1].id).toBe(moving.id);
    });

    it("refuses to empty the source, to overfill the destination and to use another organization's workbook", async () => {
      const { actor } = await org();
      const other = await org();
      const a = await workbook(actor, "A");
      const b = await workbook(actor, "B");
      const foreign = await workbook(other.actor, "Foreign");
      await expect(structure.updateTable(deps, actor, a.tableId, { workbookId: b.workbookId })).rejects.toBeInstanceOf(ConflictError);
      const { table: spare } = await structure.createTable(deps, actor, { workbookId: a.workbookId, name: "Spare" });
      await expect(structure.updateTable(deps, actor, spare.id, { workbookId: foreign.workbookId })).rejects.toBeInstanceOf(NotFoundError);
      expect((await tabs(a.workbookId)).map((t) => t.id)).toContain(spare.id);
      for (let n = 0; n < 99; n += 1) await structure.duplicateTable(deps, actor, b.tableId);
      await expect(structure.updateTable(deps, actor, spare.id, { workbookId: b.workbookId })).rejects.toThrow(/at most 100 tables/);
    }, 60_000);

    it("lets two moves in opposite directions finish without a deadlock", async () => {
      const { actor } = await org();
      const a = await workbook(actor, "A");
      const b = await workbook(actor, "B");
      const { table: a2 } = await structure.createTable(deps, actor, { workbookId: a.workbookId, name: "A2" });
      const { table: b2 } = await structure.createTable(deps, actor, { workbookId: b.workbookId, name: "B2" });
      const settled = await Promise.allSettled([
        structure.updateTable(deps, actor, a2.id, { workbookId: b.workbookId }),
        structure.updateTable(deps, actor, b2.id, { workbookId: a.workbookId }),
      ]);
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await tabs(a.workbookId)).map((t) => t.id).sort()).toEqual([a.tableId, b2.id].sort());
      expect((await tabs(b.workbookId)).map((t) => t.id).sort()).toEqual([b.tableId, a2.id].sort());
    });
  });
});
