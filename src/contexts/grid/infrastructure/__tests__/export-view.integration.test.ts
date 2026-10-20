import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import { ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. The export follows the member's own view. */

describeDb("grid export follows the view", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let io: typeof import("../../application/import-export");

  async function member(organizationId: string, role: string): Promise<Actor> {
    const [{ id }] = await sql`insert into users (name, email) values ('U', ${`${uniqueKey()}@ev.test`}) returning id`;
    users.push(id);
    return { userId: id, organizationId, role };
  }

  /** A table with `count` rows: name "p<i>" and score i (1-based), written by SQL so 50,001 rows stay quick. */
  async function setup(count: number) {
    const created = await createTestOrg(sql, "ev");
    orgs.push(created);
    const org = created.organizationId;
    const admin = await member(org, "admin");
    const alice = await member(org, "member");
    const { table } = await structure.createWorkbook(deps, admin, { name: "W", firstTableName: "Leads" });
    const name = (await columnsUc.createColumn(deps, admin, table.id, { name: "Name", type: "text", config: {} })).column.key;
    const score = (await columnsUc.createColumn(deps, admin, table.id, { name: "Score", type: "number", config: {} })).column.key;
    await sql`delete from grid_rows where table_id = ${table.id}`;
    await sql`
      insert into grid_rows (organization_id, table_id, position, cells, cell_meta)
      select ${org}, ${table.id}, g, jsonb_build_object(${name}::text, 'p' || g, ${score}::text, g), '{}'::jsonb
      from generate_series(1, ${count}) g`;
    return { org, admin, alice, tableId: table.id, name, score };
  }

  const cond = (columnKey: string, operator: string, value: string) => ({ conjunction: "and", conditions: [{ columnKey, operator, value }] });

  async function csv(actor: Actor, tableId: string, input: Parameters<typeof io.exportTableCsv>[3]) {
    const out = await io.exportTableCsv(deps, actor, tableId, input);
    let text = "";
    for await (const chunk of out.chunks) text += chunk;
    const lines = text.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "");
    return { filename: out.filename, rowCount: out.rowCount, header: lines[0], rows: lines.slice(1) };
  }

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    io = await import("../../application/import-export");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs, users);
    await sql.end();
  });

  it("exports only the 40 rows of a filtered view, and everything without useView", async () => {
    const s = await setup(100);
    await structure.updateTable(deps, s.admin, s.tableId, { view: { filters: cond(s.score, "lte", "40") } });
    const filtered = await csv(s.alice, s.tableId, { useView: true });
    expect(filtered.rowCount).toBe(40);
    expect(filtered.rows).toHaveLength(40);
    expect(filtered.filename).toBe("leads-40-rows.csv");
    const whole = await csv(s.alice, s.tableId, { columnKeys: [s.name] });
    expect(whole.rows).toHaveLength(100);
  });

  it("gives each member their own view and the sort order of the grid", async () => {
    const s = await setup(100);
    await structure.updateTable(deps, s.admin, s.tableId, { view: { filters: cond(s.score, "lte", "40") } });
    await structure.saveMyView(deps, s.alice, s.tableId, { filters: cond(s.score, "gt", "95"), sorts: [{ columnKey: s.score, direction: "desc" }] });
    const mine = await csv(s.alice, s.tableId, { useView: true, columnKeys: [s.name] });
    expect(mine.rows).toEqual(["p100", "p99", "p98", "p97", "p96"]);
    const theirs = await csv(s.admin, s.tableId, { useView: true, columnKeys: [s.name] });
    expect(theirs.rows).toHaveLength(40);
    expect(theirs.rows[0]).toBe("p1");
  });

  it("applies the search box, on its own and on top of the view", async () => {
    const s = await setup(100);
    expect((await csv(s.alice, s.tableId, { search: "p7", columnKeys: [s.name] })).rows).toEqual(["p7", "p70", "p71", "p72", "p73", "p74", "p75", "p76", "p77", "p78", "p79"]);
    await structure.updateTable(deps, s.admin, s.tableId, { view: { filters: cond(s.score, "lte", "72") } });
    const both = await csv(s.alice, s.tableId, { useView: true, search: "p7", columnKeys: [s.name] });
    expect(both.rows).toEqual(["p7", "p70", "p71", "p72"]);
  });

  it("lets rowIds win over the view", async () => {
    const s = await setup(20);
    await structure.updateTable(deps, s.admin, s.tableId, { view: { filters: cond(s.score, "lte", "5") } });
    const ids = (await deps.rows.list(s.org, s.tableId, { limit: 3, offset: 10, columns: [] })).map((r) => r.id);
    const out = await csv(s.alice, s.tableId, { useView: true, rowIds: ids, columnKeys: [s.name] });
    expect(out.rows).toEqual(["p11", "p12", "p13"]);
  });

  it("pages a sorted export past one batch without a repeat or a gap", async () => {
    const s = await setup(2_500);
    await structure.saveMyView(deps, s.alice, s.tableId, { sorts: [{ columnKey: s.score, direction: "desc" }] });
    const out = await csv(s.alice, s.tableId, { useView: true, columnKeys: [s.score] });
    expect(out.rows).toHaveLength(2_500);
    expect(out.rows.map(Number)).toEqual(Array.from({ length: 2_500 }, (_, i) => 2_500 - i));
  });

  it("checks the 50,000-row limit against the filtered count", async () => {
    const s = await setup(50_001);
    await expect(csv(s.alice, s.tableId, {})).rejects.toThrow(/more than 50,000 rows/);
    await expect(csv(s.alice, s.tableId, { useView: true })).rejects.toThrow(ValidationError);
    await structure.saveMyView(deps, s.alice, s.tableId, { filters: cond(s.score, "lte", "30") });
    const out = await csv(s.alice, s.tableId, { useView: true, columnKeys: [s.score] });
    expect(out.rowCount).toBe(30);
    expect(out.rows).toHaveLength(30);
  }, 60_000);
});
