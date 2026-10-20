import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import { todayIn } from "../../domain/formula-dates";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("date formulas and the organization time zone", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");
  let recalc: typeof import("../../application/formula-recalc");

  async function org(zone: string) {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "fd");
    await sql`update organizations set timezone = ${zone} where id = ${id}`;
    return { id, actor: { userId, organizationId: id, role: "member" } as Actor };
  }

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
    recalc = await import("../../application/formula-recalc");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("reads the organization zone, preferring the general channel setting when it holds a valid zone", async () => {
    const { id } = await org("Asia/Seoul");
    expect(await deps.formulas.organizationTimeZone(id)).toBe("Asia/Seoul");
    await sql`insert into channel_settings (organization_id, channel, values) values (${id}, 'general', ${sql.json({ timeZone: "America/Los_Angeles" })})`;
    expect(await deps.formulas.organizationTimeZone(id)).toBe("America/Los_Angeles");
    await sql`update channel_settings set values = ${sql.json({ timeZone: "Nowhere/Land" })} where organization_id = ${id} and channel = 'general'`;
    expect(await deps.formulas.organizationTimeZone(id)).toBe("Asia/Seoul");
  });

  it("falls back to UTC for an unknown organization", async () => {
    expect(await deps.formulas.organizationTimeZone("00000000-0000-0000-0000-000000000000")).toBe("UTC");
  });

  it("writes TODAY in the organization zone, leaves other rows alone on an edit, and refreshes on Recalculate", async () => {
    const { actor } = await org("Pacific/Kiritimati");
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    const { column: label } = await columnsUc.createColumn(deps, actor, table.id, { name: "Label", type: "text" });
    const first = (await rowsUc.getTablePage(deps, actor, table.id, { limit: 10 })).rows[0];
    const { column: today } = await columnsUc.createColumn(deps, actor, table.id, { name: "Today", type: "formula", config: { expression: "TODAY()" } });
    const { column: age } = await columnsUc.createColumn(deps, actor, table.id, { name: "Age", type: "formula", config: { expression: "DATEDIF('2000-01-01', TODAY(), 'Y')" } });
    const read = async () => (await rowsUc.getTablePage(deps, actor, table.id, { limit: 10 })).rows[0];

    const before = todayIn(new Date(), "Pacific/Kiritimati");
    const row = await read();
    const after = todayIn(new Date(), "Pacific/Kiritimati");
    expect([before, after]).toContain(row.cells[today.key]);
    expect(row.cells[age.key]).toBeGreaterThanOrEqual(26);

    // Plant a stale value, then edit another column of the same row: the volatile formulas recalculate.
    await sql`update grid_rows set cells = jsonb_set(cells, ${[today.key]}, '"1999-12-31"') where id = ${first.id}`;
    await rowsUc.editCells(deps, actor, table.id, [{ rowId: first.id, columnKey: label.key, value: "x" }]);
    expect([before, after]).toContain((await read()).cells[today.key]);

    // The same stale value survives an edit that does not go through a recalculation of this table.
    await sql`update grid_rows set cells = jsonb_set(cells, ${[today.key]}, '"1999-12-31"') where id = ${first.id}`;
    expect((await read()).cells[today.key]).toBe("1999-12-31");
    await recalc.recalculateFormula(deps, actor.organizationId, table.id, today.key);
    expect([before, after]).toContain((await read()).cells[today.key]);
  });
});
