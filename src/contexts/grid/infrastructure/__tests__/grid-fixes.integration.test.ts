import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GridDeps, RowStore } from "../../application/ports";
import { RowConflictError } from "../../domain/row-conflict";
import { ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("grid row store fixes", () => {
  const sql = testSql({ max: 6 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let store: RowStore;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");

  async function setup(columns: Array<[string, string]>) {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "fx");
    const actor: Actor = { userId, organizationId: id, role: "member" };
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    const keys: string[] = [];
    for (const [name, type] of columns) keys.push((await columnsUc.createColumn(deps, actor, table.id, { name, type, config: {} })).column.key);
    return { actor, org: id, tableId: table.id, keys };
  }

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    store = deps.rows;
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const cellsOf = async (rowId: string) => (await sql`select cells from grid_rows where id = ${rowId}`)[0].cells as Record<string, unknown>;

  describe("applyEdits with repeated rows", () => {
    it("applies every edit to a row and reports the value before all of them", async () => {
      const { org, tableId, keys } = await setup([["A", "text"], ["B", "text"]]);
      const [a, b] = keys;
      const [row] = await store.addBlank(org, tableId, 1, 100);
      await store.applyEdits(org, tableId, [{ rowId: row.id, set: { [a]: "old" } }]);
      const result = await store.applyEdits(org, tableId, [
        { rowId: row.id, set: { [a]: "first", [b]: "x" } },
        { rowId: row.id, set: { [a]: "second" } },
      ]);
      expect(await cellsOf(row.id)).toMatchObject({ [a]: "second", [b]: "x" });
      expect(result.previous.get(row.id)).toMatchObject({ [a]: "old" });
      expect(result.rows).toHaveLength(1);
    });

    it("rejects two edits that name different expectedVersion values, and writes nothing", async () => {
      const { org, tableId, keys } = await setup([["A", "text"]]);
      const [row] = await store.addBlank(org, tableId, 1, 100);
      await expect(
        store.applyEdits(org, tableId, [
          { rowId: row.id, set: { [keys[0]]: "x" }, expectedVersion: row.version },
          { rowId: row.id, set: { [keys[0]]: "y" }, expectedVersion: row.version + 1 },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await cellsOf(row.id))[keys[0]]).toBeUndefined();
    });

    it("checks the shared expectedVersion once against the stored version", async () => {
      const { org, tableId, keys } = await setup([["A", "text"], ["B", "text"]]);
      const [row] = await store.addBlank(org, tableId, 1, 100);
      await expect(
        store.applyEdits(org, tableId, [
          { rowId: row.id, set: { [keys[0]]: "x" } },
          { rowId: row.id, set: { [keys[1]]: "y" }, expectedVersion: row.version + 5 },
        ]),
      ).rejects.toBeInstanceOf(RowConflictError);
      expect(await cellsOf(row.id)).toEqual({});
    });
  });

  describe("number filters", () => {
    it("matches stored strings like +5, .5 and 1e5 and sorts them with numbers", async () => {
      const { org, tableId, keys, actor } = await setup([["N", "number"]]);
      const n = keys[0];
      const rows = await store.addBlank(org, tableId, 6, 100);
      const values: unknown[] = [10, "+5", ".5", "1e5", "N/A", null];
      for (const [i, v] of values.entries()) await sql`update grid_rows set cells = ${sql.json({ [n]: v } as never)} where id = ${rows[i].id}`;
      const columns = [{ key: n, type: "number" }];
      const ids = async (operator: string, value?: string, sorts?: Array<{ columnKey: string; direction: "asc" | "desc" }>) =>
        (await store.list(org, tableId, { limit: 100, offset: 0, columns, query: { filters: { conjunction: "and", conditions: [{ columnKey: n, operator: operator as "gt", value }] }, sorts } })).map((r) => rows.findIndex((x) => x.id === r.id));
      expect((await ids("gt", "1")).sort()).toEqual([0, 1, 3]);
      expect(await ids("eq", "+5")).toEqual([1]);
      expect(await ids("eq", "0.5")).toEqual([2]);
      expect(await ids("eq", "1e5")).toEqual([3]);
      expect(await ids("lt", ".6")).toEqual([2]);
      expect(await ids("gt", "0", [{ columnKey: n, direction: "asc" }])).toEqual([2, 1, 0, 3]);
      void actor;
    });

    it("treats an unparseable stored filter value as inactive instead of matching nothing or everything", async () => {
      const { org, tableId, keys } = await setup([["N", "number"]]);
      const n = keys[0];
      const rows = await store.addBlank(org, tableId, 2, 100);
      await sql`update grid_rows set cells = ${sql.json({ [n]: 1 } as never)} where id = ${rows[0].id}`;
      const all = await store.count(org, tableId);
      const columns = [{ key: n, type: "number" }];
      const count = (operator: string) => store.count(org, tableId, { columns, query: { filters: { conjunction: "and", conditions: [{ columnKey: n, operator: operator as "eq", value: "abc" }] } } });
      expect(await count("eq")).toBe(all);
      expect(await count("neq")).toBe(all);
      expect(await count("gt")).toBe(all);
    });

    it("refuses to save a view whose number filter value is not a number", async () => {
      const { actor, tableId, keys } = await setup([["N", "number"]]);
      const view = { filters: { conjunction: "and", conditions: [{ columnKey: keys[0], operator: "gt", value: "abc" }] } };
      await expect(structure.updateTable(deps, { ...actor, role: "owner" }, tableId, { view })).rejects.toThrow(/not a number/);
      await expect(structure.updateTable(deps, { ...actor, role: "owner" }, tableId, { view: { filters: { conjunction: "and", conditions: [{ columnKey: keys[0], operator: "gt", value: "+5" }] } } })).resolves.toBeDefined();
    });
  });

  describe("changes feed", () => {
    /** Follows hasMore until the feed settles, returning every row id delivered and the final cursor. */
    async function drain(org: string, tableId: string, from: string, limit: number) {
      const seen: string[] = [];
      let cursor = from;
      for (let i = 0; i < 200; i += 1) {
        const page = await store.changesSince(org, tableId, cursor, limit);
        seen.push(...page.rows.map((r) => r.id));
        cursor = page.cursor;
        if (!page.hasMore) return { seen, cursor };
      }
      throw new Error("feed did not settle");
    }

    it("pages by version without skipping and settles when drained", async () => {
      const { org, tableId } = await setup([["A", "text"]]);
      const start = await store.currentCursor(org, tableId);
      const rows = await store.addBlank(org, tableId, 23, 100);
      const first = await store.changesSince(org, tableId, start, 5);
      expect(first.hasMore).toBe(true);
      expect(first.rows).toHaveLength(5);
      const { seen, cursor } = await drain(org, tableId, start, 5);
      expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
      const quiet = await store.changesSince(org, tableId, cursor, 5);
      expect(quiet.hasMore).toBe(false);
    });

    it("delivers a row from a transaction that commits late, after many newer rows were paged past", async () => {
      const { org, tableId, keys } = await setup([["A", "text"]]);
      const rows = await store.addBlank(org, tableId, 40, 100);
      const start = await store.currentCursor(org, tableId);

      // The slow writer takes the lowest version and stays uncommitted.
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockedReady = new Promise<void>((resolve) => (locked = resolve));
      const slow = sql.begin(async (tx) => {
        await tx`update grid_rows set cells = ${tx.json({ [keys[0]]: "late" } as never)} where id = ${rows[0].id}`;
        locked();
        await hold;
      });
      await lockedReady;

      // Fast writers commit many newer versions, more than one page and more than any fixed overlap.
      for (const row of rows.slice(1, 31)) await sql`update grid_rows set cells = ${sql.json({ [keys[0]]: "fast" } as never)} where id = ${row.id}`;

      const during = await drain(org, tableId, start, 4);
      expect(during.seen).not.toContain(rows[0].id);
      expect(new Set(during.seen)).toEqual(new Set(rows.slice(1, 31).map((r) => r.id)));

      // More commits push the settled cursor further while the slow transaction is still open.
      for (const row of rows.slice(31)) await sql`update grid_rows set cells = ${sql.json({ [keys[0]]: "fast" } as never)} where id = ${row.id}`;
      const mid = await drain(org, tableId, during.cursor, 4);

      release();
      await slow;
      const after = await drain(org, tableId, mid.cursor, 4);
      expect(after.seen).toContain(rows[0].id);
    });

    it("accepts a bare version from an older client", async () => {
      const { org, tableId, actor } = await setup([["A", "text"]]);
      const page = await rowsUc.getTablePage(deps, actor, tableId);
      await rowsUc.addRows(deps, actor, tableId, 1);
      const changes = await rowsUc.getChanges(deps, actor, tableId, String(Number(page.cursor.split(":")[0])));
      expect(changes.rows.length).toBeGreaterThan(0);
      await expect(rowsUc.getChanges(deps, actor, tableId, "nonsense")).rejects.toBeInstanceOf(ValidationError);
      void org;
    });
  });
});
