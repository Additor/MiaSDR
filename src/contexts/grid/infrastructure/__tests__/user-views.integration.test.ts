import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { GridDeps } from "../../application/ports";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";

describeDb("per-user grid views", () => {
  const sql = testSql({ max: 4 });
  useTestEnv();
  const orgs: string[] = [];
  const users: string[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");

  async function member(organizationId: string, role: string): Promise<Actor> {
    const [{ id }] = await sql`insert into users (name, email) values ('U', ${`${uniqueKey()}@uv.test`}) returning id`;
    users.push(id);
    return { userId: id, organizationId, role };
  }

  async function setup() {
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('uv', ${`uv-${uniqueKey()}`}) returning id`;
    orgs.push(org);
    const admin = await member(org, "admin");
    const alice = await member(org, "member");
    const bob = await member(org, "member");
    const { table } = await structure.createWorkbook(deps, admin, { name: "W", firstTableName: "T" });
    const a = (await columnsUc.createColumn(deps, admin, table.id, { name: "Name", type: "text", config: {} })).column.key;
    const b = (await columnsUc.createColumn(deps, admin, table.id, { name: "Score", type: "number", config: {} })).column.key;
    // A new table starts with one blank row.
    const rows = [...(await deps.rows.list(org, table.id, { limit: 10, offset: 0, columns: [] })), ...(await deps.rows.addBlank(org, table.id, 2, 100))];
    await deps.rows.applyEdits(org, table.id, [
      { rowId: rows[0].id, set: { [a]: "ann", [b]: "1" } },
      { rowId: rows[1].id, set: { [a]: "bea", [b]: "5" } },
      { rowId: rows[2].id, set: { [a]: "cy", [b]: "9" } },
    ]);
    return { org, admin, alice, bob, tableId: table.id, a, b };
  }

  const cond = (columnKey: string, operator: string, value: string) => ({ conjunction: "and", conditions: [{ columnKey, operator, value }] });
  const namesOf = async (actor: Actor, tableId: string, a: string) => (await rowsUc.getTablePage(deps, actor, tableId)).rows.map((r) => r.cells[a]);

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("gives two members different views of one table, and leaves the default alone", async () => {
    const { alice, bob, tableId, a, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { filters: cond(b, "gte", "5"), sorts: [{ columnKey: b, direction: "desc" }] });
    await structure.saveMyView(deps, bob, tableId, { hiddenColumns: [b], filters: cond(a, "contains", "an") });

    expect(await namesOf(alice, tableId, a)).toEqual(["cy", "bea"]);
    expect(await namesOf(bob, tableId, a)).toEqual(["ann"]);
    const aliceView = await rowsUc.getTablePage(deps, alice, tableId);
    const bobView = await rowsUc.getTablePage(deps, bob, tableId);
    expect(aliceView.personalView).toBe(true);
    expect(bobView.view.hiddenColumns).toEqual([b]);
    expect(aliceView.view.hiddenColumns ?? []).toEqual([]);
    expect(aliceView.defaultView).toEqual({});
    expect((await deps.structure.getTable(alice.organizationId, tableId))?.view).toEqual({});
    expect(await sql`select 1 from grid_user_views where table_id = ${tableId}`).toHaveLength(2);
  });

  it("applies the member's view to select-all-matching too", async () => {
    const { alice, bob, tableId, a, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { filters: cond(b, "gte", "5") });
    expect((await rowsUc.selectRows(deps, alice, tableId)).rowIds).toHaveLength(2);
    expect((await rowsUc.selectRows(deps, bob, tableId)).rowIds).toHaveLength(3);
    void a;
  });

  it("only owners and admins change the default, and a member's save does not", async () => {
    const { admin, alice, bob, tableId, a, b } = await setup();
    const view = { sorts: [{ columnKey: b, direction: "asc" }], filters: cond(b, "gte", "5") };
    await expect(structure.updateTable(deps, alice, tableId, { view })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(structure.updateTable(deps, alice, tableId, { name: "Renamed" })).resolves.toBeDefined();
    await structure.updateTable(deps, admin, tableId, { view });
    expect(await namesOf(bob, tableId, a)).toEqual(["bea", "cy"]);
    expect((await rowsUc.getTablePage(deps, bob, tableId)).canEditDefault).toBe(false);
    expect((await rowsUc.getTablePage(deps, admin, tableId)).canEditDefault).toBe(true);
  });

  it("lets a member turn a default filter off for themselves only", async () => {
    const { admin, alice, bob, tableId, a, b } = await setup();
    await structure.updateTable(deps, admin, tableId, { view: { filters: cond(b, "gte", "5") } });
    await structure.saveMyView(deps, alice, tableId, { filters: { conjunction: "and", conditions: [] } });
    expect(await namesOf(alice, tableId, a)).toHaveLength(3);
    expect(await namesOf(bob, tableId, a)).toHaveLength(2);
    const [row] = await sql`select view from grid_user_views where table_id = ${tableId} and user_id = ${alice.userId}`;
    expect(row.view).toEqual({ filters: { conjunction: "and", conditions: [] } });
  });

  it("follows a later change of the default for keys the member never set", async () => {
    const { admin, alice, tableId, a, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: b, direction: "desc" }] });
    await structure.updateTable(deps, admin, tableId, { view: { filters: cond(b, "lt", "9") } });
    expect(await namesOf(alice, tableId, a)).toEqual(["bea", "ann"]);
  });

  it("stores no row when the member's view equals the default, and removes an old one", async () => {
    const { alice, tableId, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: b, direction: "asc" }] });
    expect(await sql`select 1 from grid_user_views where table_id = ${tableId}`).toHaveLength(1);
    await structure.saveMyView(deps, alice, tableId, { sorts: [] });
    expect(await sql`select 1 from grid_user_views where table_id = ${tableId}`).toHaveLength(0);
  });

  it("keeps one row per member and table when the member saves again", async () => {
    const { alice, tableId, a, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: b, direction: "asc" }] });
    await structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: a, direction: "desc" }] });
    const rows = await sql`select view from grid_user_views where table_id = ${tableId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].view).toEqual({ sorts: [{ columnKey: a, direction: "desc" }] });
  });

  it("resets to the default", async () => {
    const { alice, tableId, a, b } = await setup();
    await structure.saveMyView(deps, alice, tableId, { filters: cond(b, "gte", "9") });
    expect(await namesOf(alice, tableId, a)).toEqual(["cy"]);
    const reset = await structure.resetMyView(deps, alice, tableId);
    expect(reset.personal).toBe(false);
    expect(await namesOf(alice, tableId, a)).toHaveLength(3);
  });

  it("stores a member's pins, lets an admin default pin apply to others, and lets a member unpin it", async () => {
    const { admin, alice, bob, tableId, a, b } = await setup();
    // Member pin reaches storage and stays out of other members' view.
    const saved = await structure.saveMyView(deps, alice, tableId, { pinnedColumns: [b] });
    expect(saved.view.pinnedColumns).toEqual([b]);
    expect(saved.personal).toBe(true);
    const [row] = await sql`select view from grid_user_views where table_id = ${tableId} and user_id = ${alice.userId}`;
    expect(row.view).toEqual({ pinnedColumns: [b] });
    expect((await rowsUc.getTablePage(deps, bob, tableId)).view.pinnedColumns ?? []).toEqual([]);
    // An admin default pin applies to members who store no pins of their own.
    await structure.updateTable(deps, admin, tableId, { view: { pinnedColumns: [a] } });
    expect((await rowsUc.getTablePage(deps, bob, tableId)).view.pinnedColumns).toEqual([a]);
    // A member override survives as a whole, and an empty list unpins the default for that member only.
    await structure.saveMyView(deps, alice, tableId, { pinnedColumns: [b] });
    expect((await rowsUc.getTablePage(deps, alice, tableId)).view.pinnedColumns).toEqual([b]);
    await structure.saveMyView(deps, alice, tableId, { pinnedColumns: [] });
    expect((await rowsUc.getTablePage(deps, alice, tableId)).view.pinnedColumns).toEqual([]);
    expect((await rowsUc.getTablePage(deps, bob, tableId)).view.pinnedColumns).toEqual([a]);
  });

  it("falls back to the admin pins when every pin a member stored points at a deleted column", async () => {
    const { admin, alice, tableId, a, b } = await setup();
    await structure.updateTable(deps, admin, tableId, { view: { pinnedColumns: [a] } });
    await structure.saveMyView(deps, alice, tableId, { pinnedColumns: [b] });
    expect((await rowsUc.getTablePage(deps, alice, tableId)).view.pinnedColumns).toEqual([b]);
    // The column goes away without touching the stored override (a delete in another session, an old row).
    await sql`delete from grid_columns where table_id = ${tableId} and key = ${b}`;
    const after = await rowsUc.getTablePage(deps, alice, tableId);
    expect(after.view.pinnedColumns).toEqual([a]);
    expect(after.personalView).toBe(false);
    // A list the member saved empty on purpose still unpins.
    await structure.saveMyView(deps, alice, tableId, { pinnedColumns: [] });
    expect((await rowsUc.getTablePage(deps, alice, tableId)).view.pinnedColumns).toEqual([]);
  });

  it("refuses more than three pins, an unknown column and a duplicate", async () => {
    const { admin, alice, tableId, a, b } = await setup();
    const c = (await columnsUc.createColumn(deps, admin, tableId, { name: "C", type: "text", config: {} })).column.key;
    const d = (await columnsUc.createColumn(deps, admin, tableId, { name: "D", type: "text", config: {} })).column.key;
    await expect(structure.saveMyView(deps, alice, tableId, { pinnedColumns: [a, b, c, d] })).rejects.toThrow(/at most 3/);
    await expect(structure.saveMyView(deps, alice, tableId, { pinnedColumns: ["nope"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(structure.saveMyView(deps, alice, tableId, { pinnedColumns: [a, a] })).rejects.toBeInstanceOf(ValidationError);
    await expect(structure.updateTable(deps, admin, tableId, { view: { pinnedColumns: [a, b, c, d] } })).rejects.toBeInstanceOf(ValidationError);
    await expect(structure.saveMyView(deps, alice, tableId, { pinnedColumns: [a, b, c] })).resolves.toBeTruthy();
  });

  it("saving the default clears the admin's own override and keeps other members'", async () => {
    const { admin, alice, tableId, a, b } = await setup();
    await structure.saveMyView(deps, admin, tableId, { filters: cond(b, "gte", "5") });
    await structure.saveMyView(deps, alice, tableId, { filters: cond(b, "gte", "9") });
    await structure.updateTable(deps, admin, tableId, { view: { filters: cond(b, "gte", "5") } });
    expect(await sql`select 1 from grid_user_views where table_id = ${tableId} and user_id = ${admin.userId}`).toHaveLength(0);
    expect(await namesOf(alice, tableId, a)).toEqual(["cy"]);
  });

  it("validates the personal view like the default", async () => {
    const { alice, tableId, b } = await setup();
    await expect(structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: "nope", direction: "asc" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(structure.saveMyView(deps, alice, tableId, { filters: cond(b, "gt", "abc") })).rejects.toThrow(/not a number/);
    await expect(structure.saveMyView(deps, alice, tableId, "nope")).rejects.toBeInstanceOf(ValidationError);
  });

  it("drops a deleted column from both layers on read", async () => {
    const { admin, alice, tableId, a, b } = await setup();
    await structure.updateTable(deps, admin, tableId, { view: { hiddenColumns: [b] } });
    await structure.saveMyView(deps, alice, tableId, { hiddenColumns: [b], filters: cond(b, "gte", "5") });
    const column = (await deps.columns.list(alice.organizationId, tableId)).find((c) => c.key === b)!;
    await columnsUc.deleteColumn(deps, admin, tableId, column.id);
    const page = await rowsUc.getTablePage(deps, alice, tableId);
    expect(page.view.hiddenColumns).toEqual([]);
    expect(page.view.filters?.conditions).toEqual([]);
    expect(page.total).toBe(3);
    void a;
  });

  describe("tenant isolation", () => {
    it("answers 404 for a table of another organization, on read and write", async () => {
      const one = await setup();
      const two = await setup();
      await expect(structure.saveMyView(deps, two.alice, one.tableId, { sorts: [] })).rejects.toBeInstanceOf(NotFoundError);
      await expect(structure.saveMyView(deps, two.alice, one.tableId, { sorts: [{ columnKey: one.b, direction: "asc" }] })).rejects.toBeInstanceOf(NotFoundError);
      await expect(structure.resetMyView(deps, two.alice, one.tableId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(rowsUc.getTablePage(deps, two.alice, one.tableId)).rejects.toBeInstanceOf(NotFoundError);
      expect(await sql`select 1 from grid_user_views where table_id = ${one.tableId}`).toHaveLength(0);
    });

    it("never reads a view row stored under another organization's id", async () => {
      const one = await setup();
      const two = await setup();
      expect(await deps.structure.getUserView(two.org, one.tableId, one.alice.userId)).toBeNull();
      await deps.structure.saveUserView(one.org, one.tableId, one.alice.userId, { sorts: [{ columnKey: one.b, direction: "asc" }] });
      expect(await deps.structure.getUserView(two.org, one.tableId, one.alice.userId)).toBeNull();
      await deps.structure.deleteUserView(two.org, one.tableId, one.alice.userId);
      expect(await deps.structure.getUserView(one.org, one.tableId, one.alice.userId)).not.toBeNull();
    });

    it("rejects a row that pairs a table with the wrong organization at the database", async () => {
      const one = await setup();
      const two = await setup();
      await expect(sql`insert into grid_user_views (organization_id, table_id, user_id) values (${two.org}, ${one.tableId}, ${two.alice.userId})`).rejects.toThrow(/foreign key/);
    });
  });

  it("removes a member's rows with the table", async () => {
    const { alice, tableId, b, org } = await setup();
    await structure.saveMyView(deps, alice, tableId, { sorts: [{ columnKey: b, direction: "asc" }] });
    await sql`delete from grid_tables where id = ${tableId} and organization_id = ${org}`;
    expect(await sql`select 1 from grid_user_views where table_id = ${tableId}`).toHaveLength(0);
  });
});
