import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { GridDeps } from "../../application/ports";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. When the page scans is in row-management.test.ts. */
describeDb("table page fill rate", () => {
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let rowsUc: typeof import("../../application/row-management");

  useTestEnv();
  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    rowsUc = await import("../../application/row-management");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("reports the share of filled cells per column on the first page", async () => {
    const { organizationId, actor } = await gridOrg(sql, orgs, "owner");
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    await sql`delete from grid_rows where table_id = ${table.id}`;
    const key = (await sql`select key from grid_columns where table_id = ${table.id} limit 1`)[0].key as string;
    const rows = await deps.rows.addBlank(organizationId, table.id, 4, 1000);
    await rowsUc.editCells(deps, actor, table.id, rows.slice(0, 3).map((r) => ({ rowId: r.id, columnKey: key, value: "x" })));
    const first = await rowsUc.getTablePage(deps, actor, table.id, { limit: 2 });
    expect(first.coverage).toEqual({ [key]: 75 });
  });
});
