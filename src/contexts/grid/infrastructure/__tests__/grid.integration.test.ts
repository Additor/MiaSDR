import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { RowConflictError } from "../../domain/row-conflict";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("grid core", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");
  let io: typeof import("../../application/import-export");
  let formulaUc: typeof import("../../application/formula-management");
  let handoffUc: typeof import("../../application/campaign-handoff");
  let events: typeof import("../../application/cell-events");
  let parseUpload: typeof import("../parse-upload").parseUpload;

  async function org(label = "g") {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, "member", label);
    return { id, actor };
  }

  /** A workbook with its seeded table, then a "name" column renamed and typed, ready for rows. */
  async function table(actor: Actor, name = "T") {
    const { workbook, table: t } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: name });
    return { workbook, table: t };
  }

  async function withColumns(actor: Actor, tableId: string, specs: Array<[string, string, Record<string, unknown>?]>) {
    const keys: string[] = [];
    for (const [name, type, config] of specs) {
      const { column } = await columnsUc.createColumn(deps, actor, tableId, { name, type, config });
      keys.push(column.key);
    }
    return keys;
  }

  const rowsOf = async (actor: Actor, tableId: string) => (await rowsUc.getTablePage(deps, actor, tableId, { limit: 1000 })).rows;
  const versionOf = async (rowId: string) => Number((await sql`select version from grid_rows where id = ${rowId}`)[0].version);

  useTestEnv();
  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
    io = await import("../../application/import-export");
    formulaUc = await import("../../application/formula-management");
    handoffUc = await import("../../application/campaign-handoff");
    events = await import("../../application/cell-events");
    parseUpload = (await import("../parse-upload")).parseUpload;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("folders, workbooks and tables", () => {
    it("nests folders, refuses a move into the subtree and releases workbooks on delete", async () => {
      const { actor } = await org();
      const { folder: root } = await structure.createFolder(deps, actor, { name: "Root" });
      const { folder: child } = await structure.createFolder(deps, actor, { name: "Child", parentId: root.id });
      const { folder: grand } = await structure.createFolder(deps, actor, { name: "Grand", parentId: child.id });
      await expect(structure.updateFolder(deps, actor, root.id, { parentId: grand.id })).rejects.toBeInstanceOf(ValidationError);
      await expect(structure.updateFolder(deps, actor, root.id, { parentId: root.id })).rejects.toBeInstanceOf(ValidationError);

      const { workbook } = await structure.createWorkbook(deps, actor, { name: "In grand", folderId: grand.id });
      const listing = await structure.getFolder(deps, actor, root.id);
      expect(listing.folders.map((f) => [f.name, f.folderCount, f.workbookCount])).toEqual([["Child", 1, 0]]);
      expect((await structure.getFolder(deps, actor, grand.id)).path.map((p) => p.name)).toEqual(["Root", "Child", "Grand"]);

      const deleted = await structure.deleteFolder(deps, actor, root.id);
      expect(deleted.released).toBe(1);
      expect((await structure.getWorkbook(deps, actor, workbook.id)).workbook.folderId).toBeNull();
      await expect(structure.getFolder(deps, actor, grand.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("seeds a new workbook with one table, a name column and one empty row", async () => {
      const { actor } = await org();
      const { table: first } = await structure.createWorkbook(deps, actor, { name: "W" });
      expect(first.name).toBe("Custom Table");
      const page = await rowsUc.getTablePage(deps, actor, first.id);
      expect(page.columns.map((c) => c.key)).toEqual(["name"]);
      expect(page.rows).toHaveLength(1);
    });

    it("duplicates a table with its cells and finished cell states, and drops the running ones", async () => {
      const { actor } = await org();
      const { table: first } = await structure.createWorkbook(deps, actor, { name: "W" });
      const [key] = await withColumns(actor, first.id, [["Company", "text"]]);
      const [row] = await rowsOf(actor, first.id);
      await rowsUc.editCells(deps, actor, first.id, [{ rowId: row.id, columnKey: key, value: "Acme" }]);
      await sql`update grid_rows set cell_meta = ${sql.json({ [key]: { status: "running" }, done: { status: "success" } } as never)} where id = ${row.id}`;
      const source = (await rowsOf(actor, first.id))[0];

      const { table: copy } = await structure.duplicateTable(deps, actor, first.id);
      expect(copy.name).toBe("Custom Table (copy)");
      const copied = await rowsUc.getTablePage(deps, actor, copy.id);
      expect(copied.rows[0].cells[key]).toBe("Acme");
      expect(Object.keys(copied.rows[0].cellMeta)).toEqual(["done"]);
      expect(copied.rows[0].version).toBeGreaterThan(source.version);
    });

    describe("with three tables in one workbook", () => {
      let actor: Actor;
      let workbookId = "";
      let ids: string[] = [];
      beforeAll(async () => {
        ({ actor } = await org());
        const { workbook, table: first } = await structure.createWorkbook(deps, actor, { name: "W" });
        workbookId = workbook.id;
        const { table: second } = await structure.createTable(deps, actor, { workbookId, name: "Second" });
        const { table: third } = await structure.createTable(deps, actor, { workbookId, name: "Third" });
        ids = [first.id, second.id, third.id];
      });

      it("reorders the tables", async () => {
        const order = [ids[2], ids[0], ids[1]];
        expect((await structure.reorderTables(deps, actor, workbookId, order)).tables.map((t) => t.id)).toEqual(order);
      });

      it("refuses an order that leaves out or repeats a table", async () => {
        await expect(structure.reorderTables(deps, actor, workbookId, [ids[2], ids[0]])).rejects.toBeInstanceOf(ValidationError);
        await expect(structure.reorderTables(deps, actor, workbookId, [ids[2], ids[0], ids[0]])).rejects.toBeInstanceOf(ValidationError);
      });

      it("moves a table to another workbook", async () => {
        const { workbook: other } = await structure.createWorkbook(deps, actor, { name: "Other" });
        const moved = await structure.updateTable(deps, actor, ids[2], { workbookId: other.id });
        expect(moved.table.workbookId).toBe(other.id);
      });
    });

    it("deletes a table but refuses to delete the last one of a workbook", async () => {
      const { actor } = await org();
      const { workbook, table: first } = await structure.createWorkbook(deps, actor, { name: "W" });
      const { table: second } = await structure.createTable(deps, actor, { workbookId: workbook.id, name: "Second" });
      await structure.deleteTable(deps, actor, second.id);
      await expect(structure.deleteTable(deps, actor, first.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("filters to the rows whose run failed in a column", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [a] = await withColumns(actor, t.id, [["Alpha", "text"]]);
      await rowsUc.addRows(deps, actor, t.id, 2);
      const [bad] = (await sql`select id from grid_rows where table_id = ${t.id} order by position limit 1`) as unknown as Array<{ id: string }>;
      await sql`update grid_rows set cell_meta = ${sql.json({ [a]: { status: "error", error: "boom" } } as never)} where id = ${bad.id}`;
      await structure.updateTable(deps, { ...actor, role: "owner" }, t.id, { view: { filters: { conjunction: "and", conditions: [{ columnKey: a, operator: "runFailed" }] } } });
      const page = await rowsUc.getTablePage(deps, actor, t.id);
      expect(page.rows.map((r: { id: string }) => r.id)).toEqual([bad.id]);
    });

    it("saves a view and drops what a deleted column leaves behind", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [a] = await withColumns(actor, t.id, [["Alpha", "text"]]);
      await expect(structure.updateTable(deps, { ...actor, role: "owner" }, t.id, { view: { sorts: [{ columnKey: "nope", direction: "asc" }] } })).rejects.toBeInstanceOf(ValidationError);
      await structure.updateTable(deps, { ...actor, role: "owner" }, t.id, { view: { hiddenColumns: [a], sorts: [{ columnKey: a, direction: "desc" }], filters: { conjunction: "and", conditions: [{ columnKey: a, operator: "notEmpty" }] } } });
      const { column } = (await columnsUc.listColumns(deps, actor, t.id)).columns.map((c) => ({ column: c })).find((c) => c.column.key === a)!;
      await columnsUc.deleteColumn(deps, actor, t.id, column.id);
      const page = await rowsUc.getTablePage(deps, actor, t.id);
      expect(page.view).toEqual({ hiddenColumns: [], sorts: [], filters: { conjunction: "and", conditions: [] } });
    });
  });

  describe("columns", () => {
    it("records the columns a formula reads as its dependencies", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [price, qty] = await withColumns(actor, t.id, [["Price", "number"], ["Qty", "number"]]);
      const { column: total } = await columnsUc.createColumn(deps, actor, t.id, { name: "Total", type: "formula", config: { expression: `{{${price}}} * {{${qty}}}` } });
      expect(total.dependsOn.sort()).toEqual([price, qty].sort());
    });

    it("refuses a formula on an unknown column, a broken formula, an unknown type and an overlong expression", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      await expect(columnsUc.createColumn(deps, actor, t.id, { name: "Bad", type: "formula", config: { expression: "{{ghost}} + 1" } })).rejects.toThrow(/unknown column/);
      await expect(columnsUc.createColumn(deps, actor, t.id, { name: "Bad", type: "formula", config: { expression: "1 +" } })).rejects.toBeInstanceOf(ValidationError);
      await expect(columnsUc.createColumn(deps, actor, t.id, { name: "Bad", type: "bogus" })).rejects.toBeInstanceOf(ValidationError);
      await expect(columnsUc.createColumn(deps, actor, t.id, { name: "Bad", type: "formula", config: { expression: "x".repeat(6000) } })).rejects.toBeInstanceOf(ValidationError);
    });

    it("blocks a formula loop and the delete of a column a formula reads, and allows the delete once the formula is gone", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [price, qty] = await withColumns(actor, t.id, [["Price", "number"], ["Qty", "number"]]);
      const { column: total } = await columnsUc.createColumn(deps, actor, t.id, { name: "Total", type: "formula", config: { expression: `{{${price}}} * {{${qty}}}` } });
      // price now reads total, total reads price: a loop.
      const priceColumn = (await columnsUc.listColumns(deps, actor, t.id)).columns.find((c) => c.key === price)!;
      await expect(columnsUc.updateColumn(deps, actor, t.id, priceColumn.id, { type: "formula", config: { expression: `{{${total.key}}}` } })).rejects.toThrow(/Circular/);
      await expect(columnsUc.deleteColumn(deps, actor, t.id, priceColumn.id)).rejects.toThrow(/used by/);
      await columnsUc.deleteColumn(deps, actor, t.id, total.id);
      await columnsUc.deleteColumn(deps, actor, t.id, priceColumn.id);
      expect((await columnsUc.listColumns(deps, actor, t.id)).columns.map((c) => c.key)).not.toContain(price);
    });

    it("keeps keys and names unique and orders by position", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const a = (await columnsUc.createColumn(deps, actor, t.id, { name: "Same", type: "text" })).column;
      const b = (await columnsUc.createColumn(deps, actor, t.id, { name: "Same", type: "text" })).column;
      expect([a.key, b.key]).toEqual(["same", "same2"]);
      expect([a.name, b.name]).toEqual(["Same", "Same 2"]);
      const c = (await columnsUc.createColumn(deps, actor, t.id, { name: "First", type: "text", beforeColumnId: a.id })).column;
      const order = (await columnsUc.listColumns(deps, actor, t.id)).columns.map((x) => x.key);
      expect(order.indexOf(c.key)).toBeLessThan(order.indexOf(a.key));
      await expect(columnsUc.updateColumn(deps, actor, t.id, b.id, { name: "same" })).rejects.toThrow(/already exists/);
    });

    it("converts stored values on a type change, strips values on delete and clears jobs", async () => {
      const { actor, id: orgId } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Amount", "text"]]);
      const page = await rowsUc.getTablePage(deps, actor, t.id);
      await rowsUc.addRows(deps, actor, t.id, 2);
      const rows = await rowsOf(actor, t.id);
      await rowsUc.editCells(deps, actor, t.id, [
        { rowId: rows[0].id, columnKey: key, value: "1,200" },
        { rowId: rows[1].id, columnKey: key, value: "N/A" },
      ]);
      const column = (await columnsUc.listColumns(deps, actor, t.id)).columns.find((c) => c.key === key)!;
      await columnsUc.updateColumn(deps, actor, t.id, column.id, { type: "number" });
      const after = await rowsOf(actor, t.id);
      expect(after.map((r) => r.cells[key]).filter((v) => v !== undefined)).toEqual([1200, "N/A"]);

      await sql`insert into grid_jobs (organization_id, table_id, row_id, column_key) values (${orgId}, ${t.id}, ${page.rows[0].id}, ${key})`;
      await columnsUc.deleteColumn(deps, actor, t.id, column.id);
      expect((await rowsOf(actor, t.id)).every((r) => !(key in r.cells))).toBe(true);
      expect(await sql`select 1 from grid_jobs where table_id = ${t.id}`).toHaveLength(0);
    });

    async function fullNames() {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Full", "text"]]);
      await rowsUc.addRows(deps, actor, t.id, 3);
      const rows = await rowsOf(actor, t.id);
      await rowsUc.editCells(deps, actor, t.id, [
        { rowId: rows[0].id, columnKey: key, value: "Ada Lovelace" },
        { rowId: rows[1].id, columnKey: key, value: "Grace Hopper Murray" },
        { rowId: rows[2].id, columnKey: key, value: "Ada Lovelace" },
      ]);
      const column = (await columnsUc.listColumns(deps, actor, t.id)).columns.find((c) => c.key === key)!;
      return { actor, tableId: t.id, column };
    }

    it("splits text into new columns right after the source and refuses an unknown separator", async () => {
      const { actor, tableId, column } = await fullNames();
      await expect(columnsUc.textToColumns(deps, actor, tableId, column.id, "tilde")).rejects.toBeInstanceOf(ValidationError);
      expect(await columnsUc.textToColumns(deps, actor, tableId, column.id, "space")).toEqual({ columnsCreated: 3, rowsUpdated: 4 });
      const cols = (await columnsUc.listColumns(deps, actor, tableId)).columns.map((c) => c.name);
      expect(cols.slice(-3)).toEqual(["Full 1", "Full 2", "Full 3"]);
      expect(cols.indexOf("Full 1")).toBe(cols.indexOf("Full") + 1);
      const split = await rowsOf(actor, tableId);
      expect(split[1].cells.full3).toBe("Murray");
      expect(split[2].cells.full).toBe("Ada Lovelace");
    });

    it("deletes the rows that repeat a value of the column", async () => {
      const { actor, tableId, column } = await fullNames();
      const before = await rowsOf(actor, tableId);
      const result = await columnsUc.dedupeColumn(deps, actor, tableId, column.id);
      const after = await rowsOf(actor, tableId);
      expect(after.map((r) => r.cells.full ?? null)).toEqual(["Ada Lovelace", "Grace Hopper Murray", null]);
      const removed = before.filter((r) => !after.some((a) => a.id === r.id)).map((r) => r.id);
      expect(result).toEqual({ deleted: 1, rowIds: removed });
    });
  });

  describe("rows, cell edits and versions", () => {
    it("bumps the row version on every edit and rejects runner and unknown columns", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key, calc] = [await withColumns(actor, t.id, [["Note", "text"]]).then((k) => k[0]), await columnsUc.createColumn(deps, actor, t.id, { name: "Calc", type: "formula", config: { expression: "1 + 1" } }).then((r) => r.column.key)];
      const [row] = await rowsOf(actor, t.id);
      const v0 = await versionOf(row.id);
      const result = await rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: key, value: "hello" }]);
      expect(result.rows[0].version).toBeGreaterThan(v0);
      expect(result.rows[0].version).toBe(await versionOf(row.id));
      await expect(rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: calc, value: 3 }])).rejects.toThrow(/calculates from its formula/);
      await expect(rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: "ghost", value: 3 }])).rejects.toBeInstanceOf(ValidationError);
      await expect(rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: key, value: "a" }, { rowId: row.id, columnKey: key, value: "b" }])).rejects.toThrow(/same cell twice/);
      await expect(rowsUc.editCells(deps, actor, t.id, [{ rowId: "00000000-0000-4000-8000-000000000000", columnKey: key, value: "a" }])).rejects.toBeInstanceOf(NotFoundError);
    });

    it("detects a stale version, reports the current row and writes nothing", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Note", "text"]]);
      await rowsUc.addRows(deps, actor, t.id, 1);
      const [one, two] = await rowsOf(actor, t.id);

      // Two clients read the same version. The first saves, the second is stale.
      const seen = one.version;
      const first = await rowsUc.editCells(deps, actor, t.id, [{ rowId: one.id, columnKey: key, value: "first", expectedVersion: seen }]);
      expect(first.rows[0].version).toBeGreaterThan(seen);

      const err = await rowsUc
        .editCells(deps, actor, t.id, [
          { rowId: two.id, columnKey: key, value: "other row", expectedVersion: two.version },
          { rowId: one.id, columnKey: key, value: "second", expectedVersion: seen },
        ])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RowConflictError);
      const conflict = (err as RowConflictError).conflicts;
      expect(conflict).toHaveLength(1);
      expect(conflict[0]).toMatchObject({ rowId: one.id, expectedVersion: seen, currentVersion: first.rows[0].version });
      expect(conflict[0].cells?.[key]).toBe("first");
      expect((err as RowConflictError).details).toEqual({ conflicts: conflict });
      // The batch was atomic: the second row, which was current, stayed unwritten too.
      const after = await rowsOf(actor, t.id);
      expect(after.find((r) => r.id === two.id)?.cells[key]).toBeUndefined();
      expect(after.find((r) => r.id === one.id)?.cells[key]).toBe("first");

      // Retrying with the version from the conflict succeeds.
      const retry = await rowsUc.editCells(deps, actor, t.id, [{ rowId: one.id, columnKey: key, value: "second", expectedVersion: conflict[0].currentVersion as number }]);
      expect(retry.rows[0].cells[key]).toBe("second");
      // Without expectedVersion the write wins.
      await rowsUc.editCells(deps, actor, t.id, [{ rowId: one.id, columnKey: key, value: "third" }]);
      expect((await rowsOf(actor, t.id)).find((r) => r.id === one.id)?.cells[key]).toBe("third");
    });

    it("serializes two concurrent versioned edits: one wins, one conflicts", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Note", "text"]]);
      const [row] = await rowsOf(actor, t.id);
      const results = await Promise.allSettled(
        ["a", "b", "c", "d"].map((value) => rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: key, value, expectedVersion: row.version }])),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected" && r.reason instanceof RowConflictError)).toHaveLength(3);
    });

    it("tells listeners which cells changed and skips unchanged values", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Note", "text"]]);
      const [row] = await rowsOf(actor, t.id);
      const seen: unknown[] = [];
      const listener = async (event: { tableId: string; changes: unknown[] }) => {
        if (event.tableId === t.id) seen.push(...event.changes);
        return event.tableId === t.id && event.changes.length ? 5 : 0;
      };
      events.registerCellsChangedListener(listener);
      const one = await rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: key, value: "x" }]);
      const two = await rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: key, value: "x" }]);
      expect(seen).toEqual([{ rowId: row.id, columnKey: key, previous: null, value: "x" }]);
      // The listener reports 5 queued cells for the one real change and nothing for the repeat.
      expect([one.queued, two.queued]).toEqual([5, 0]);
    });

    it("queues the auto-run columns that read an edited cell, through the enrichment module", async () => {
      const { actor, id } = await org();
      const { table: t } = await table(actor);
      const [note] = await withColumns(actor, t.id, [["Note", "text"]]);
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
        values (${id}, ${t.id}, 'summary', 'Summary', 'ai', ${sql.json({ prompt: `Summarize {{${note}}}` } as never)}, ${[note]}, 99, true)`;
      const [row] = await rowsOf(actor, t.id);
      const empty = await rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: note, value: null }]);
      expect(empty.queued).toBe(0);
      const edited = await rowsUc.editCells(deps, actor, t.id, [{ rowId: row.id, columnKey: note, value: "Long text" }]);
      expect(edited.queued).toBe(1);
      expect((await sql`select column_key, status from grid_jobs where table_id = ${t.id}`).map((j) => [j.column_key, j.status])).toEqual([["summary", "queued"]]);
      // The generic endpoint will not create or retarget a runner column from raw JSON.
      await expect(columnsUc.createColumn(deps, actor, t.id, { name: "Sneaky", type: "ai", config: { prompt: "x" } })).rejects.toThrow(/own setup dialog/);
      const summary = (await columnsUc.listColumns(deps, actor, t.id)).columns.find((c) => c.key === "summary")!;
      await expect(columnsUc.updateColumn(deps, actor, t.id, summary.id, { config: { prompt: "other" } })).rejects.toThrow(/own setup dialog/);
      expect((await columnsUc.updateColumn(deps, actor, t.id, summary.id, { name: "Short", autoRun: false })).column).toMatchObject({ name: "Short", autoRun: false });
    });

    it("feeds changes by cursor and reports the row total", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Note", "text"]]);
      await rowsUc.addRows(deps, actor, t.id, 2);
      const page = await rowsUc.getTablePage(deps, actor, t.id);
      expect(page.activeJobs).toBe(0);
      const rows = page.rows;
      // An open transaction anywhere on the server holds the snapshot horizon back, and the feed then repeats rows it
      // already sent. A repeat is safe for the client, so the checks look only at rows whose version is new.
      const known = new Map(rows.map((r) => [r.id, r.version]));
      const fresh = (feed: { rows: Array<{ id: string; version: number }> }) => feed.rows.filter((r) => known.get(r.id) !== r.version).map((r) => r.id);

      const quiet = await rowsUc.getChanges(deps, actor, t.id, page.cursor);
      expect(fresh(quiet)).toEqual([]);
      expect(quiet.hasMore).toBe(false);

      await rowsUc.editCells(deps, actor, t.id, [{ rowId: rows[1].id, columnKey: key, value: "changed" }]);
      const changes = await rowsUc.getChanges(deps, actor, t.id, page.cursor);
      expect(fresh(changes)).toEqual([rows[1].id]);
      expect(changes.rows.find((r) => r.id === rows[1].id)?.cells[key]).toBe("changed");
      expect(changes.cursor).not.toBe(page.cursor);
      expect(changes.total).toBe(3);

      // The settled cursor brings no new version of a row it already delivered.
      for (const r of changes.rows) known.set(r.id, r.version);
      const again = await rowsUc.getChanges(deps, actor, t.id, changes.cursor);
      expect(fresh(again)).toEqual([]);

      await rowsUc.deleteRows(deps, actor, t.id, [rows[0].id]);
      expect((await rowsUc.getChanges(deps, actor, t.id, changes.cursor)).total).toBe(2);
      await expect(rowsUc.getChanges(deps, actor, t.id, "-1")).rejects.toBeInstanceOf(ValidationError);

      await sql`insert into grid_jobs (organization_id, table_id, row_id, column_key, status) values (${actor.organizationId}, ${t.id}, ${rows[1].id}, ${key}, 'queued')`;
      expect((await rowsUc.getChanges(deps, actor, t.id, changes.cursor)).activeJobs).toBe(1);
    });

    it("filters, sorts, searches and selects through the saved view", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [name, score] = await withColumns(actor, t.id, [["Who", "text"], ["Score", "number"]]);
      await rowsUc.addRows(deps, actor, t.id, 3);
      const rows = await rowsOf(actor, t.id);
      const data: Array<[string, number | string]> = [["Ada", 30], ["Grace", 5], ["Linus", "N/A"], ["50% Off", 100]];
      await rowsUc.editCells(deps, actor, t.id, data.flatMap(([n, s], i) => [{ rowId: rows[i].id, columnKey: name, value: n }, { rowId: rows[i].id, columnKey: score, value: s }]));

      await structure.updateTable(deps, { ...actor, role: "owner" }, t.id, { view: { sorts: [{ columnKey: score, direction: "desc" }], filters: { conjunction: "and", conditions: [{ columnKey: score, operator: "gte", value: "5" }] } } });
      const page = await rowsUc.getTablePage(deps, actor, t.id);
      expect(page.rows.map((r) => r.cells[name])).toEqual(["50% Off", "Ada", "Grace"]);
      expect([page.total, page.unfilteredTotal]).toEqual([3, 4]);

      expect((await rowsUc.getTablePage(deps, actor, t.id, { search: "50%" })).rows.map((r) => r.cells[name])).toEqual(["50% Off"]);
      // % and _ match literally, not as wildcards.
      expect((await rowsUc.getTablePage(deps, actor, t.id, { search: "%" })).total).toBe(1);
      expect((await rowsUc.getTablePage(deps, actor, t.id, { search: "'; drop table grid_rows; --" })).total).toBe(0);
      const selection = await rowsUc.selectRows(deps, actor, t.id, { search: "a" });
      expect(selection.rowIds).toHaveLength(2);
      expect(page.coverage[name]).toBe(100);
    });

    it("enforces row, update and page limits", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [key] = await withColumns(actor, t.id, [["Note", "text"]]);
      await expect(rowsUc.addRows(deps, actor, t.id, 1001)).rejects.toBeInstanceOf(ValidationError);
      await expect(rowsUc.addRows(deps, actor, t.id, 0)).rejects.toBeInstanceOf(ValidationError);
      await expect(deps.rows.addBlank(actor.organizationId, t.id, 5, 3)).rejects.toBeInstanceOf(ConflictError);
      await expect(rowsUc.editCells(deps, actor, t.id, [])).rejects.toBeInstanceOf(ValidationError);
      const many = Array.from({ length: 5001 }, (_, i) => ({ rowId: "00000000-0000-4000-8000-000000000000", columnKey: `${key}`, value: i }));
      await expect(rowsUc.editCells(deps, actor, t.id, many)).rejects.toBeInstanceOf(ValidationError);
      const wide = Array.from({ length: 1001 }, (_, i) => ({ rowId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, columnKey: key, value: "x" }));
      await expect(rowsUc.editCells(deps, actor, t.id, wide)).rejects.toThrow(/more than 1,000 rows/);
      await expect(rowsUc.editCells(deps, actor, t.id, [{ rowId: "00000000-0000-4000-8000-000000000000", columnKey: key, value: "x".repeat(30_000) }])).rejects.toThrow(/characters or fewer/);
    });
  });

  describe("tenant isolation", () => {
    it("treats another organization's ids as missing on every entry point", async () => {
      const a = await org("a");
      const b = await org("b");
      const { workbook, table: t } = await table(a.actor);
      const [key] = await withColumns(a.actor, t.id, [["Note", "text"]]);
      const [row] = await rowsOf(a.actor, t.id);
      const column = (await columnsUc.listColumns(deps, a.actor, t.id)).columns.find((c) => c.key === key)!;
      const { folder } = await structure.createFolder(deps, a.actor, { name: "Private" });
      await rowsUc.editCells(deps, a.actor, t.id, [{ rowId: row.id, columnKey: key, value: "secret" }]);

      const denied = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(NotFoundError);
      await denied(structure.getWorkbook(deps, b.actor, workbook.id));
      await denied(structure.getFolder(deps, b.actor, folder.id));
      await denied(structure.deleteWorkbook(deps, b.actor, workbook.id));
      await denied(structure.deleteFolder(deps, b.actor, folder.id));
      await denied(structure.updateFolder(deps, b.actor, folder.id, { name: "mine" }));
      await denied(structure.updateTable(deps, b.actor, t.id, { name: "mine" }));
      await denied(structure.duplicateTable(deps, b.actor, t.id));
      await denied(structure.deleteTable(deps, b.actor, t.id));
      await denied(structure.createTable(deps, b.actor, { workbookId: workbook.id }));
      await denied(structure.reorderTables(deps, b.actor, workbook.id, [t.id]));
      await denied(columnsUc.listColumns(deps, b.actor, t.id));
      await denied(columnsUc.createColumn(deps, b.actor, t.id, { name: "x", type: "text" }));
      await denied(columnsUc.updateColumn(deps, b.actor, t.id, column.id, { name: "x" }));
      await denied(columnsUc.deleteColumn(deps, b.actor, t.id, column.id));
      await denied(columnsUc.dedupeColumn(deps, b.actor, t.id, column.id));
      await denied(columnsUc.textToColumns(deps, b.actor, t.id, column.id, "comma"));
      await denied(rowsUc.getTablePage(deps, b.actor, t.id));
      await denied(rowsUc.listRows(deps, b.actor, t.id));
      await denied(rowsUc.addRows(deps, b.actor, t.id, 1));
      await denied(rowsUc.deleteRows(deps, b.actor, t.id, [row.id]));
      await denied(rowsUc.editCells(deps, b.actor, t.id, [{ rowId: row.id, columnKey: key, value: "pwn" }]));
      await denied(rowsUc.selectRows(deps, b.actor, t.id));
      await denied(rowsUc.getChanges(deps, b.actor, t.id, "0"));
      await denied(io.exportTableCsv(deps, b.actor, t.id));
      await denied(io.previewImport(deps, b.actor, t.id, { headers: ["a"], rows: [["1"]] }, "x.csv"));
      await denied(io.runImport(deps, b.actor, t.id, { headers: ["a"], rows: [["1"]] }, [{ headerIndex: 0, action: "create", type: "text" }]));
      await denied(formulaUc.previewFormula(deps, b.actor, t.id, { expression: "1" }));
      await denied(handoffUc.pushToCampaign(deps, b.actor, t.id, { rowIds: [row.id], target: { newCampaignName: "x" }, fields: { email: key } }));

      // Same-organization access still works and nothing was changed.
      const page = await rowsUc.getTablePage(deps, a.actor, t.id);
      expect(page.rows[0].cells[key]).toBe("secret");
      expect(page.table.name).toBe(t.name);
      // Cross-tenant moves are refused too.
      const { workbook: bWorkbook } = await structure.createWorkbook(deps, b.actor, { name: "B" });
      await denied(structure.updateTable(deps, a.actor, t.id, { workbookId: bWorkbook.id }));
      await denied(structure.updateWorkbook(deps, a.actor, workbook.id, { folderId: (await structure.createFolder(deps, b.actor, { name: "B folder" })).folder.id }));
    });

    describe("with rows in another table and another organization", () => {
      async function strangers() {
        const a = await org("a");
        const b = await org("b");
        const { table: own } = await table(a.actor, "Own");
        const { table: sibling } = await table(a.actor, "Sibling");
        const { table: foreign } = await table(b.actor, "Foreign");
        const [siblingRow] = await rowsOf(a.actor, sibling.id);
        const [foreignRow] = await rowsOf(b.actor, foreign.id);
        await rowsUc.editCells(deps, a.actor, sibling.id, [{ rowId: siblingRow.id, columnKey: "name", value: "sibling" }]);
        await rowsUc.editCells(deps, b.actor, foreign.id, [{ rowId: foreignRow.id, columnKey: "name", value: "foreign" }]);
        const cellsOf = async (rowId: string) => (await sql`select cells from grid_rows where id = ${rowId}`)[0]?.cells;
        return { a, own, siblingRow, foreignRow, cellsOf };
      }

      it("deletes no row of another table or organization through the table it names", async () => {
        const { a, own, siblingRow, foreignRow, cellsOf } = await strangers();
        expect(await rowsUc.deleteRows(deps, a.actor, own.id, [siblingRow.id, foreignRow.id])).toEqual({ deleted: 0 });
        expect(await cellsOf(siblingRow.id)).toEqual({ name: "sibling" });
        expect(await cellsOf(foreignRow.id)).toEqual({ name: "foreign" });
        expect(await rowsOf(a.actor, own.id)).toHaveLength(1);
      });

      it("refuses a cell edit on a row of another table or organization and leaves it unchanged", async () => {
        const { a, own, siblingRow, foreignRow, cellsOf } = await strangers();
        for (const rowId of [siblingRow.id, foreignRow.id]) {
          await expect(rowsUc.editCells(deps, a.actor, own.id, [{ rowId, columnKey: "name", value: "pwn" }])).rejects.toBeInstanceOf(NotFoundError);
        }
        expect(await cellsOf(siblingRow.id)).toEqual({ name: "sibling" });
        expect(await cellsOf(foreignRow.id)).toEqual({ name: "foreign" });
      });
    });

    it("keeps lookups inside the organization", async () => {
      const a = await org("a");
      const b = await org("b");
      const { table: ta } = await table(a.actor, "Companies");
      const { table: tb } = await table(b.actor, "Companies");
      const [domainB, industryB] = await withColumns(b.actor, tb.id, [["Domain", "text"], ["Industry", "text"]]);
      const [rowB] = await rowsOf(b.actor, tb.id);
      await rowsUc.editCells(deps, b.actor, tb.id, [{ rowId: rowB.id, columnKey: domainB, value: "acme.io" }, { rowId: rowB.id, columnKey: industryB, value: "Secret industry" }]);
      const [domainA] = await withColumns(a.actor, ta.id, [["Domain", "text"]]);
      const [rowA] = await rowsOf(a.actor, ta.id);
      await rowsUc.editCells(deps, a.actor, ta.id, [{ rowId: rowA.id, columnKey: domainA, value: "acme.io" }]);
      // Table "Companies" of org A has no Industry column. Org B's table must not satisfy the lookup.
      await expect(
        formulaUc.previewFormula(deps, a.actor, ta.id, { expression: `LOOKUP("Companies", {{${domainA}}}, "Domain", "Industry")` }),
      ).rejects.toThrow(/unknown or ambiguous/);
    });
  });

  describe("formulas", () => {
    it("previews against a row, with cross-table lookups, and never writes", async () => {
      const { actor } = await org();
      const { workbook, table: people } = await table(actor, "People");
      const [first, last, company] = await withColumns(actor, people.id, [["First", "text"], ["Last", "text"], ["Company", "text"]]);
      const { table: companies } = await structure.createTable(deps, actor, { workbookId: workbook.id, name: "Companies" });
      const [name, industry] = await withColumns(actor, companies.id, [["Company name", "text"], ["Industry", "text"]]);
      await rowsUc.addRows(deps, actor, people.id, 1);
      const [p1] = await rowsOf(actor, people.id);
      await rowsUc.editCells(deps, actor, people.id, [{ rowId: p1.id, columnKey: first, value: "Ada" }, { rowId: p1.id, columnKey: company, value: "Acme" }]);
      const [c1] = await rowsOf(actor, companies.id);
      await rowsUc.editCells(deps, actor, companies.id, [{ rowId: c1.id, columnKey: name, value: "Acme" }, { rowId: c1.id, columnKey: industry, value: "Rockets" }]);

      const before = await versionOf(p1.id);
      const joined = await formulaUc.previewFormula(deps, actor, people.id, { expression: `{{${first}}} + " " + {{${last}}} + "!"` });
      expect(joined).toMatchObject({ ok: true, value: "Ada !", rowNumber: 1 });
      const looked = await formulaUc.previewFormula(deps, actor, people.id, { expression: `LOOKUP("Companies", {{${company}}}, "Company name", "Industry", "n/a")`, rowId: p1.id });
      expect(looked.value).toBe("Rockets");
      expect(await versionOf(p1.id)).toBe(before);

      await expect(formulaUc.previewFormula(deps, actor, people.id, { expression: "{{nope}}" })).rejects.toThrow(/unknown column/);
      await expect(formulaUc.previewFormula(deps, actor, people.id, { expression: "1 / 0" })).rejects.toThrow(/Division by zero/);
      await expect(formulaUc.previewFormula(deps, actor, people.id, { expression: "x".repeat(6000) })).rejects.toBeInstanceOf(ValidationError);
      await expect(formulaUc.previewFormula(deps, actor, people.id, { expression: 'LOOKUP("Nowhere", 1, "a", "b")' })).rejects.toThrow(/unknown or ambiguous/);
      await expect(formulaUc.previewFormula(deps, actor, people.id, { expression: "1", rowId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("generates through the provider resolver and checks what comes back", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [first] = await withColumns(actor, t.id, [["First", "text"]]);
      const answers = [`=NOPE({{${first}}})`, `UPPER({{${first}}})`];
      const calls: unknown[] = [];
      const author = {
        forOrganization: async () => ({
          complete: async (input: unknown) => {
            calls.push(input);
            return { formula: answers[calls.length - 1], explanation: "" };
          },
        }),
        status: async () => ({ state: "on" as const, provider: "Anthropic", model: "m" }),
      };
      const out = await formulaUc.generateFormula({ ...deps, formulaAuthor: author }, actor, t.id, { prompt: "shout the name" });
      expect(out.formula).toBe(`UPPER({{${first}}})`);
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls[1])).toContain("Unknown function NOPE");

      const stubborn = { ...author, forOrganization: async () => ({ complete: async () => ({ formula: "{{ghost}}", explanation: "" }) }) };
      await expect(formulaUc.generateFormula({ ...deps, formulaAuthor: stubborn }, actor, t.id, { prompt: "x" })).rejects.toThrow(/could not produce a working formula/);
      const none = { forOrganization: async () => null, status: async () => ({ state: "no_model" as const, provider: "OpenRouter" }) };
      await expect(formulaUc.generateFormula({ ...deps, formulaAuthor: none }, actor, t.id, { prompt: "x" })).rejects.toThrow(new ConflictError("AI is off. OpenRouter needs a model: ask an owner or admin to pick one."));
      await expect(formulaUc.generateFormula({ ...deps, formulaAuthor: author }, actor, t.id, { prompt: "x".repeat(3000) })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("import and export", () => {
    const upload = (text: string, name = "data.csv") => parseUpload({ name, bytes: Buffer.from(text, "utf8") });
    const exportText = async (actor: Actor, tableId: string, input = {}) => {
      const { chunks } = await io.exportTableCsv(deps, actor, tableId, input);
      let text = "";
      for await (const chunk of chunks) text += chunk;
      return text;
    };

    it("round-trips awkward values and keeps formulas inert in the file", async () => {
      const { actor } = await org();
      const { table: source } = await table(actor, "Source");
      const csv = [
        "Name,Notes,Score,Active",
        'Ada,"line one\nline two",1200,yes',
        '"Hopper, Grace","she said ""hi""",3.5,no',
        "한국어 이름,\"=HYPERLINK(\"\"http://evil\"\")\",-5,yes",
        "Plus,+1+1,@cmd,",
        "Spaced,  =1+1,0,",
      ].join("\r\n");
      const sheet = await upload("﻿" + csv);
      const preview = await io.previewImport(deps, actor, source.id, sheet, "data.csv");
      expect(preview.totalRows).toBe(5);
      expect(preview.mapping.map((m) => m.action)).toEqual(["create", "create", "create", "create"]);
      expect(preview.mapping.map((m) => (m.action === "create" ? m.type : null))).toEqual(["text", "text", "text", "boolean"]);

      const mapping = preview.mapping.map((m, i) => (i === 2 ? { ...m, type: "number" } : i === 3 ? { ...m, type: "boolean" } : m));
      const done = await io.runImport(deps, actor, source.id, sheet, mapping);
      expect(done).toMatchObject({ rowsInserted: 5, columnsCreated: 4 });
      const page = await rowsUc.getTablePage(deps, actor, source.id);
      // The fresh table's placeholder row and "New Column" were replaced.
      expect(page.columns.map((c) => c.name)).toEqual(["Name", "Notes", "Score", "Active"]);
      expect(page.rows).toHaveLength(5);
      expect(page.rows[0].cells).toMatchObject({ name: "Ada", notes: "line one\nline two", score: 1200, active: true });
      expect(page.rows[3].cells.score).toBe("@cmd");

      const exported = await exportText(actor, source.id);
      expect(exported.startsWith("﻿")).toBe(true);
      // Every cell a spreadsheet would run is prefixed with an apostrophe.
      expect(exported).toContain("'=HYPERLINK");
      expect(exported).toContain("'+1+1");
      expect(exported).toContain("'@cmd");
      expect(exported).toContain("Spaced,'=1+1");
      expect(exported).not.toMatch(/(^|,)=HYPERLINK/m);

      // Import the export into a second table: the values come back unchanged.
      const { table: copy } = await table(actor, "Copy");
      const again = await upload(exported);
      const second = await io.previewImport(deps, actor, copy.id, again, "export.csv");
      await io.runImport(deps, actor, copy.id, again, second.mapping.map((m, i) => (i === 2 ? { ...m, type: "number" } : i === 3 ? { ...m, type: "boolean" } : m)));
      const back = await rowsUc.getTablePage(deps, actor, copy.id);
      expect(back.rows.map((r) => r.cells)).toEqual(page.rows.map((r) => r.cells));
      expect(back.columns.map((c) => c.key)).toEqual(page.columns.map((c) => c.key));
    });

    it("exports a selection in the order given, with chosen columns", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [a, b] = await withColumns(actor, t.id, [["A", "text"], ["B", "text"]]);
      await rowsUc.addRows(deps, actor, t.id, 2);
      const rows = await rowsOf(actor, t.id);
      await rowsUc.editCells(deps, actor, t.id, rows.flatMap((r, i) => [{ rowId: r.id, columnKey: a, value: `a${i}` }, { rowId: r.id, columnKey: b, value: `b${i}` }]));
      const text = await exportText(actor, t.id, { rowIds: [rows[2].id, rows[0].id], columnKeys: [b, a] });
      expect(text.replace("﻿", "")).toBe("B,A\r\nb2,a2\r\nb0,a0\r\n");
      const { filename } = await io.exportTableCsv(deps, actor, t.id, { rowIds: [rows[0].id] });
      expect(filename).toMatch(/^t-1-rows\.csv$/);
      await expect(io.exportTableCsv(deps, actor, t.id, { rowIds: [rows[0].id, "00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/do not belong/);
      await expect(io.exportTableCsv(deps, actor, t.id, { rowIds: [] })).rejects.toBeInstanceOf(ValidationError);
      await expect(io.exportTableCsv(deps, actor, t.id, { columnKeys: ["ghost"] })).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses oversized files, too many rows and bad mappings, and imports nothing", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      await expect(upload("a,b\n" + "x".repeat(6 * 1024 * 1024))).rejects.toBeInstanceOf(ValidationError);
      const tooMany = { headers: ["a"], rows: Array.from({ length: 10_001 }, () => ["x"]) };
      await expect(io.runImport(deps, actor, t.id, tooMany, [{ headerIndex: 0, action: "create", type: "text" }])).rejects.toThrow(/limit is 10,000/);
      const tooWide = { headers: Array.from({ length: 201 }, (_, i) => `h${i}`), rows: [Array.from({ length: 201 }, () => "x")] };
      await expect(io.previewImport(deps, actor, t.id, tooWide, "x.csv")).rejects.toThrow(/201 columns/);
      await expect(io.runImport(deps, actor, t.id, { headers: ["a"], rows: [["1"]] }, [{ headerIndex: 0, action: "skip" }])).rejects.toThrow(/skip/);
      await expect(io.runImport(deps, actor, t.id, { headers: ["a"], rows: [["1"]] }, [{ headerIndex: 0, action: "map", columnKey: "ghost" }])).rejects.toBeInstanceOf(ValidationError);
      await expect(io.runImport(deps, actor, t.id, { headers: [], rows: [] }, [])).rejects.toBeInstanceOf(ValidationError);
      expect((await rowsUc.getTablePage(deps, actor, t.id)).rows).toHaveLength(1);
      // A table at its row limit takes no more.
      await expect(
        deps.rows.importRecords(actor.organizationId, t.id, () => ({ newColumns: [], records: [{ a: 1 }, { a: 2 }] }), { maxRows: 2, maxColumns: 200 }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("imports more rows than one insert batch holds, in file order", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const count = 1201;
      const sheet = { headers: ["Company", "Rank"], rows: Array.from({ length: count }, (_, i) => [`Company ${i + 1}`, String(i + 1)]) };
      const done = await io.runImport(deps, actor, t.id, sheet, [
        { headerIndex: 0, action: "create", name: "Company", type: "text" },
        { headerIndex: 1, action: "create", name: "Rank", type: "text" },
      ]);
      expect(done.rowsInserted).toBe(count);
      const stored = await sql`select cells from grid_rows where table_id = ${t.id} order by position, id`;
      expect(stored).toHaveLength(count);
      expect(stored[499].cells).toEqual({ company: "Company 500", rank: "500" });
      expect(stored[500].cells).toEqual({ company: "Company 501", rank: "501" });
      expect(stored[count - 1].cells).toEqual({ company: `Company ${count}`, rank: String(count) });
    });

    const canReuseSeed = async (organizationId: string, tableId: string) => {
      let seen: boolean | null = null;
      await deps.rows.importRecords(organizationId, tableId, (state) => { seen = state.canReuseSeed; return { newColumns: [], records: [] }; }, { maxRows: 100, maxColumns: 200 });
      return seen;
    };

    it("replaces a lone seed column with the first imported column", async () => {
      const { actor } = await org();
      const { table: lone } = await table(actor);
      expect(await canReuseSeed(actor.organizationId, lone.id)).toBe(true);
      const sheet = await upload("Company\nAcme\n");
      await io.runImport(deps, actor, lone.id, sheet, [{ headerIndex: 0, action: "create", name: "Company", type: "text" }]);
      expect((await deps.columns.list(actor.organizationId, lone.id)).map((c) => c.key)).toEqual(["company"]);
    });

    it("keeps the seed column key when a formula depends on it", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor, "Dependent");
      // A recalculation writes the formula's result into the placeholder row, so the state is built directly: seed, formula column, empty row.
      await sql`insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position) values (${actor.organizationId}, ${t.id}, 'shout', 'Shout', 'formula', ${sql.json({ expression: "UPPER({{name}})" } as never)}, ${sql.array(["name"])}, 2)`;
      expect(await canReuseSeed(actor.organizationId, t.id)).toBe(false);
      const sheet = await upload("Company\nAcme\n");
      await io.runImport(deps, actor, t.id, sheet, [{ headerIndex: 0, action: "create", name: "Company", type: "text" }]);
      const keys = (await deps.columns.list(actor.organizationId, t.id)).map((c) => c.key);
      expect(keys.filter((k) => k === "name")).toHaveLength(1);
      expect(keys).toContain("company");
    });

    it("maps onto existing columns and appends below existing rows", async () => {
      const { actor } = await org();
      const { table: t } = await table(actor);
      const [email] = await withColumns(actor, t.id, [["Email", "email"]]);
      await rowsUc.addRows(deps, actor, t.id, 1);
      const [first, second] = await rowsOf(actor, t.id);
      await rowsUc.editCells(deps, actor, t.id, [{ rowId: second.id, columnKey: email, value: "keep@x.io" }]);
      const sheet = await upload("Email,Extra\na@x.io,1\nb@x.io,2\n");
      const preview = await io.previewImport(deps, actor, t.id, sheet, "x.csv");
      expect(preview.mapping[0]).toEqual({ headerIndex: 0, action: "map", columnKey: email });
      await io.runImport(deps, actor, t.id, sheet, [preview.mapping[0], { headerIndex: 1, action: "skip" }]);
      const rows = await rowsOf(actor, t.id);
      expect(rows.map((r) => r.cells[email] ?? null)).toEqual([null, "keep@x.io", "a@x.io", "b@x.io"]);
      expect(rows[0].id).toBe(first.id);
    });
  });

  describe("campaign handoff", () => {
    async function fixture() {
      const o = await org("c");
      const { table: t } = await table(o.actor);
      const [email, first, company, score] = await withColumns(o.actor, t.id, [["Email", "text"], ["First", "text"], ["Company", "text"], ["Score", "number"]]);
      const data = [
        { email: "new@acme.io", first: "New", company: "Acme", score: 1 },
        { email: "Existing@Acme.io", first: "Existing", company: "Acme", score: 2 },
        { email: "suppressed@acme.io", first: "Sup", company: "Acme", score: 3 },
        { email: "dnc@acme.io", first: "Dnc", company: "Acme", score: 4 },
        { email: "enrolled@acme.io", first: "Enr", company: "Acme", score: 5 },
        { email: "", first: "NoMail", company: "Acme", score: 6 },
        { email: "not an email", first: "Bad", company: "Acme", score: 7 },
        { email: "new@acme.io", first: "Dup", company: "Acme", score: 8 },
      ];
      await rowsUc.addRows(deps, o.actor, t.id, data.length - 1);
      const rows = await rowsOf(o.actor, t.id);
      await rowsUc.editCells(
        deps,
        o.actor,
        t.id,
        data.flatMap((d, i) => [
          { rowId: rows[i].id, columnKey: email, value: d.email },
          { rowId: rows[i].id, columnKey: first, value: d.first },
          { rowId: rows[i].id, columnKey: company, value: d.company },
          { rowId: rows[i].id, columnKey: score, value: d.score },
        ]),
      );
      const [{ id: existing }] = await sql`insert into people (organization_id, email, first_name, full_name) values (${o.id}, 'existing@acme.io', 'Old', 'Old Name') returning id`;
      const [{ id: dncPerson }] = await sql`insert into people (organization_id, email, first_name) values (${o.id}, 'dnc@acme.io', 'Dnc') returning id`;
      const [{ id: enrolledPerson }] = await sql`insert into people (organization_id, email, first_name) values (${o.id}, 'enrolled@acme.io', 'Enr') returning id`;
      await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${dncPerson}, ${o.id}, true, 'human', now())`;
      await sql`insert into suppression_list (organization_id, email, reason) values (${o.id}, 'suppressed@acme.io', 'unsubscribed')`;
      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${o.id}, 'email', 'Target', 'draft') returning id`;
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${o.id}, ${campaignId}, ${enrolledPerson}, 'email', 'active')`;
      return { ...o, tableId: t.id, rows: await rowsOf(o.actor, t.id), cols: { email, first, company, score }, existing, campaignId };
    }

    it("creates leads, enrolls the eligible rows and reports every skip", async () => {
      const f = await fixture();
      const report = await handoffUc.pushToCampaign(deps, f.actor, f.tableId, {
        rowIds: f.rows.map((r) => r.id),
        target: { campaignId: f.campaignId },
        fields: { email: f.cols.email, firstName: f.cols.first, companyName: f.cols.company },
        customColumnKeys: [f.cols.score],
      });
      const reasonOf = (i: number) => report.failures.find((x) => x.rowId === f.rows[i].id)?.reason;
      expect(report.channel).toBe("email");
      expect(report.created).toBe(false);
      expect(report.enrolled).toBe(2);
      expect(reasonOf(2)).toBe("Email is suppressed");
      expect(reasonOf(3)).toBe("Person is marked do not contact");
      expect(reasonOf(4)).toBe("Person is already in this campaign");
      expect(reasonOf(5)).toBe("Missing or invalid email");
      expect(reasonOf(6)).toBe("Missing or invalid email");
      expect(reasonOf(7)).toBe("Same lead as an earlier selected row");
      expect(report.failures).toHaveLength(6);

      const enrolled = await sql`select p.email, e.channel, e.status from campaign_enrollments e join people p on p.id = e.person_id where e.campaign_id = ${f.campaignId} and e.status = 'pending' order by p.email`;
      expect(enrolled.map((r) => r.email)).toEqual(["existing@acme.io", "new@acme.io"]);
      // The existing lead was updated through the lead rules, not duplicated.
      expect(await sql`select id from people where organization_id = ${f.id} and lower(email) = 'existing@acme.io'`).toHaveLength(1);
      const [updated] = await sql`select first_name, custom from people where id = ${f.existing}`;
      expect(updated.first_name).toBe("Existing");
      expect(updated.custom).toEqual({ x_score: "2" });
      // A suppressed address and a row without a valid address never became leads.
      expect(await sql`select 1 from people where organization_id = ${f.id} and email = 'suppressed@acme.io'`).toHaveLength(0);
      // Nothing was sent or queued by the handoff, and the campaign is still a draft.
      expect((await sql`select status from campaigns where id = ${f.campaignId}`)[0].status).toBe("draft");
      expect(await sql`select 1 from sends where organization_id = ${f.id}`).toHaveLength(0);

      // Pushing the same rows again enrolls nobody and fails nobody twice for the same reason.
      const repeat = await handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[0].id, f.rows[1].id], target: { campaignId: f.campaignId }, fields: { email: f.cols.email } });
      expect(repeat.enrolled).toBe(0);
      expect(repeat.failures.map((x) => x.reason)).toEqual(["Person is already in this campaign", "Person is already in this campaign"]);
    });

    it("creates a draft campaign for a name and refuses bad targets and mappings", async () => {
      const f = await fixture();
      const other = await org("other");
      const [{ id: foreign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${other.id}, 'email', 'Foreign', 'draft') returning id`;
      const base = { rowIds: [f.rows[0].id], fields: { email: f.cols.email } };

      const made = await handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, target: { newCampaignName: "From grid" } });
      expect(made).toMatchObject({ created: true, enrolled: 1, channel: "email" });
      const [campaign] = await sql`select name, status, organization_id from campaigns where id = ${made.campaignId}`;
      expect(campaign).toMatchObject({ name: "From grid", status: "draft", organization_id: f.id });

      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, target: { campaignId: foreign } })).rejects.toBeInstanceOf(NotFoundError);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, target: {} })).rejects.toBeInstanceOf(ValidationError);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, target: { campaignId: f.campaignId, newCampaignName: "x" } })).rejects.toBeInstanceOf(ValidationError);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, fields: {}, target: { campaignId: f.campaignId } })).rejects.toThrow(/Email or LinkedIn/);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { ...base, fields: { email: "ghost" }, target: { campaignId: f.campaignId } })).rejects.toThrow(/no longer exists/);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [], fields: base.fields, target: { campaignId: f.campaignId } })).rejects.toBeInstanceOf(ValidationError);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: ["00000000-0000-4000-8000-000000000000"], fields: base.fields, target: { campaignId: f.campaignId } })).rejects.toThrow(/do not belong/);
      // A row of another organization's table cannot be pushed through this table.
      const stranger = await table(other.actor);
      const [strangerRow] = await rowsOf(other.actor, stranger.table.id);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [strangerRow.id], fields: base.fields, target: { campaignId: f.campaignId } })).rejects.toThrow(/do not belong/);
      expect(await sql`select 1 from campaigns where id = ${foreign} and name = 'Foreign'`).toHaveLength(1);
    });

    it("creates no campaign when every selected row is dropped", async () => {
      const f = await fixture();
      const campaignsNamed = async (name: string) => await sql`select 1 from campaigns where organization_id = ${f.id} and name = ${name}`;
      // Suppressed, do not contact and a duplicate of an earlier row: nothing is left to enroll.
      const rowIds = [f.rows[2].id, f.rows[3].id];
      const fields = { email: f.cols.email };
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds, fields, target: { newCampaignName: "Empty one" } })).rejects.toBeInstanceOf(ValidationError);
      await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds, fields, target: { newCampaignName: "Empty one" } })).rejects.toBeInstanceOf(ValidationError);
      expect(await campaignsNamed("Empty one")).toHaveLength(0);
    });

    describe("atomic push", () => {
      /** Makes the next insert into `table` fail, so the push breaks right after that step. */
      async function failingInsertInto<T>(table: "people" | "campaigns" | "campaign_enrollments", run: () => Promise<T>) {
        await sql.unsafe(`create or replace function grid_test_block_insert() returns trigger language plpgsql as $$ begin raise exception 'blocked ${table}'; end $$`);
        await sql.unsafe(`create trigger grid_test_block_insert before insert on ${table} for each row execute function grid_test_block_insert()`);
        try {
          return await run();
        } finally {
          await sql.unsafe(`drop trigger grid_test_block_insert on ${table}`);
          await sql.unsafe(`drop function grid_test_block_insert()`);
        }
      }

      const counts = async (orgId: string) => ({
        campaigns: (await sql`select 1 from campaigns where organization_id = ${orgId}`).length,
        people: (await sql`select 1 from people where organization_id = ${orgId}`).length,
        enrollments: (await sql`select 1 from campaign_enrollments where organization_id = ${orgId}`).length,
      });

      for (const step of ["people", "campaigns", "campaign_enrollments"] as const) {
        it(`leaves nothing behind when the push fails at ${step}`, async () => {
          const f = await fixture();
          const before = await counts(f.id);
          // Row 0 is a new person, so the import, the campaign and the enrollment all have work to do.
          await expect(
            failingInsertInto(step, () => handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[0].id], fields: { email: f.cols.email }, target: { newCampaignName: "Orphan" } })),
          ).rejects.toThrow();
          expect(await counts(f.id)).toEqual(before);
        });
      }

      it("keeps the existing campaign and its enrollments when the enrollment into it fails", async () => {
        const f = await fixture();
        const before = await counts(f.id);
        await expect(
          failingInsertInto("campaign_enrollments", () => handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[0].id], fields: { email: f.cols.email }, target: { campaignId: f.campaignId } })),
        ).rejects.toThrow();
        expect(await counts(f.id)).toEqual(before);
      });

      it("creates no lead when a new campaign has nobody left to enroll", async () => {
        const f = await fixture();
        // Do not contact: the person exists, so the import finds them and the policy drops the row after the import.
        const before = await counts(f.id);
        await expect(handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[3].id], fields: { email: f.cols.email }, target: { newCampaignName: "Nobody" } })).rejects.toBeInstanceOf(ValidationError);
        expect(await counts(f.id)).toEqual(before);
      });
    });

    it("matches suppressed addresses without regard to case", async () => {
      const f = await fixture();
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.id}, 'Mixed@Acme.io', 'unsubscribed')`;
      await rowsUc.editCells(deps, f.actor, f.tableId, [{ rowId: f.rows[0].id, columnKey: f.cols.email, value: "mixed@acme.io" }]);
      const report = await handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[0].id, f.rows[1].id], fields: { email: f.cols.email }, target: { campaignId: f.campaignId } });
      expect(report.enrolled).toBe(1);
      expect(report.failures).toEqual([{ rowId: f.rows[0].id, reason: "Email is suppressed" }]);
      expect(await sql`select 1 from people where organization_id = ${f.id} and lower(email) = 'mixed@acme.io'`).toHaveLength(0);
    });

    it("skips a lead matched by LinkedIn profile whose stored email is suppressed", async () => {
      const o = await org("late");
      const { table: t } = await table(o.actor);
      const [email, url] = await withColumns(o.actor, t.id, [["Email", "text"], ["LinkedIn", "text"]]);
      const [row] = await rowsOf(o.actor, t.id);
      // The row's own address is clean. The existing lead it matches by slug carries a suppressed one.
      await rowsUc.editCells(deps, o.actor, t.id, [
        { rowId: row.id, columnKey: email, value: "new@acme.io" },
        { rowId: row.id, columnKey: url, value: "https://www.linkedin.com/in/jane-doe/" },
      ]);
      const [{ id: person }] = await sql`insert into people (organization_id, email, linkedin_slug, linkedin_url, first_name) values (${o.id}, 'old@acme.io', 'jane-doe', 'https://www.linkedin.com/in/jane-doe/', 'Jane') returning id`;
      await sql`insert into suppression_list (organization_id, email, reason) values (${o.id}, 'old@acme.io', 'unsubscribed')`;
      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${o.id}, 'email', 'C', 'draft') returning id`;
      const report = await handoffUc.pushToCampaign(deps, o.actor, t.id, { rowIds: [row.id], target: { campaignId }, fields: { email, linkedin: url } });
      expect(report.enrolled).toBe(0);
      expect(report.failures).toEqual([{ rowId: row.id, reason: "Email is suppressed" }]);
      expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaignId} and person_id = ${person}`).toHaveLength(0);
    });

    it("fails a row whose lead is already a contact, on both channels, and still enrolls the others", async () => {
      const f = await fixture();
      await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${f.existing}`;
      const report = await handoffUc.pushToCampaign(deps, f.actor, f.tableId, { rowIds: [f.rows[0].id, f.rows[1].id], fields: { email: f.cols.email }, target: { campaignId: f.campaignId } });
      expect(report.enrolled).toBe(1);
      expect(report.failures).toEqual([{ rowId: f.rows[1].id, reason: "Is a contact" }]);
      expect((await sql`select p.email from campaign_enrollments e join people p on p.id = e.person_id where e.campaign_id = ${f.campaignId} and e.status = 'pending'`).map((r) => r.email)).toEqual(["new@acme.io"]);
      // The contact stays a contact and keeps its place: the import still updated its fields.
      expect((await sql`select lifecycle from people where id = ${f.existing}`)[0].lifecycle).toBe("contact");

      const o = await org("lic");
      const { table: t } = await table(o.actor);
      const [url, name] = await withColumns(o.actor, t.id, [["Profile", "text"], ["Name", "text"]]);
      await rowsUc.addRows(deps, o.actor, t.id, 1);
      const rows = await rowsOf(o.actor, t.id);
      await rowsUc.editCells(deps, o.actor, t.id, [
        { rowId: rows[0].id, columnKey: url, value: "https://www.linkedin.com/in/ada-lovelace/" },
        { rowId: rows[0].id, columnKey: name, value: "Ada Lovelace" },
        { rowId: rows[1].id, columnKey: url, value: "https://www.linkedin.com/in/grace-hopper/" },
        { rowId: rows[1].id, columnKey: name, value: "Grace Hopper" },
      ]);
      await sql`insert into people (organization_id, linkedin_slug, full_name, lifecycle, converted_at) values (${o.id}, 'grace-hopper', 'Grace Hopper', 'contact', now())`;
      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${o.id}, 'linkedin', 'LI', 'draft') returning id`;
      const li = await handoffUc.pushToCampaign(deps, o.actor, t.id, { rowIds: rows.map((r) => r.id), target: { campaignId }, fields: { linkedin: url, fullName: name } });
      expect(li).toMatchObject({ channel: "linkedin", enrolled: 1 });
      expect(li.failures).toEqual([{ rowId: rows[1].id, reason: "Is a contact" }]);
    });

    it("enrolls into a LinkedIn campaign by profile and skips rows without one", async () => {
      const o = await org("li");
      const { table: t } = await table(o.actor);
      const [url, name] = await withColumns(o.actor, t.id, [["Profile", "text"], ["Name", "text"]]);
      await rowsUc.addRows(deps, o.actor, t.id, 1);
      const rows = await rowsOf(o.actor, t.id);
      await rowsUc.editCells(deps, o.actor, t.id, [
        { rowId: rows[0].id, columnKey: url, value: "https://www.linkedin.com/in/ada-lovelace/" },
        { rowId: rows[0].id, columnKey: name, value: "Ada Lovelace" },
        { rowId: rows[1].id, columnKey: name, value: "No profile" },
      ]);
      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${o.id}, 'linkedin', 'LI', 'draft') returning id`;
      const report = await handoffUc.pushToCampaign(deps, o.actor, t.id, { rowIds: rows.map((r) => r.id), target: { campaignId }, fields: { linkedin: url, fullName: name } });
      expect(report).toMatchObject({ channel: "linkedin", enrolled: 1 });
      expect(report.failures).toEqual([{ rowId: rows[1].id, reason: "Missing or invalid LinkedIn URL" }]);
      expect((await sql`select channel from campaign_enrollments where campaign_id = ${campaignId}`).map((r) => r.channel)).toEqual(["linkedin"]);
      expect((await sql`select linkedin_slug from people where organization_id = ${o.id}`).map((r) => r.linkedin_slug)).toEqual(["ada-lovelace"]);
      expect((await sql`select linkedin_url from people where organization_id = ${o.id}`).map((r) => r.linkedin_url)).toEqual(["https://www.linkedin.com/in/ada-lovelace/"]);
    });
  });
});
