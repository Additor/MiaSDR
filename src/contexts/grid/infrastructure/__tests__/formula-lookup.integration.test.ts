import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("formula LOOKUP dependencies", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");
  let limits: typeof import("../../application/formula-lookup-refresh").LOOKUP_REFRESH_LIMITS;

  async function org(label = "fl") {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", label);
    const actor: Actor = { userId, organizationId: id, role: "member" };
    return { id, actor };
  }

  const rowsOf = async (actor: Actor, tableId: string) => (await rowsUc.getTablePage(deps, actor, tableId, { limit: 1000 })).rows;

  /**
   * "Companies" (Domain, Industry) with one row acme.io / Software, and "People" (Domain) with one row acme.io and a
   * formula column "Industry" that looks the company up.
   */
  async function world(actor: Actor, options: { autoRun?: boolean } = {}) {
    const { workbook, table: people } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "People" });
    const { table: companies } = await structure.createTable(deps, actor, { workbookId: workbook.id, name: "Companies" });
    const make = async (tableId: string, name: string, type = "text", config?: Record<string, unknown>, autoRun?: boolean) => (await columnsUc.createColumn(deps, actor, tableId, { name, type, config, autoRun })).column;
    const cDomain = await make(companies.id, "Domain");
    const cIndustry = await make(companies.id, "Industry");
    const pDomain = await make(people.id, "Domain");
    const [company] = await rowsOf(actor, companies.id);
    await rowsUc.editCells(deps, actor, companies.id, [{ rowId: company.id, columnKey: cDomain.key, value: "acme.io" }, { rowId: company.id, columnKey: cIndustry.key, value: "Software" }]);
    const [person] = await rowsOf(actor, people.id);
    await rowsUc.editCells(deps, actor, people.id, [{ rowId: person.id, columnKey: pDomain.key, value: "acme.io" }]);
    const expression = `LOOKUP("Companies", {{${pDomain.key}}}, "Domain", "Industry", "n/a")`;
    const formula = await make(people.id, "Industry", "formula", { expression }, options.autoRun);
    return { workbook, people, companies, cDomain, cIndustry, pDomain, formula, company, person, expression };
  }

  const cellOf = async (actor: Actor, tableId: string, key: string, index = 0) => {
    const row = (await rowsOf(actor, tableId))[index];
    return { value: row.cells[key], meta: row.cellMeta[key] as Record<string, unknown> | undefined };
  };

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
    limits = (await import("../../application/formula-lookup-refresh")).LOOKUP_REFRESH_LIMITS;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("computes the lookup when the column is created", async () => {
    const { actor } = await org();
    const w = await world(actor);
    expect(await cellOf(actor, w.people.id, w.formula.key)).toEqual({ value: "Software", meta: undefined });
  });

  describe("source changes refresh the dependents", () => {
    it("recalculates when a source cell is edited", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: w.cIndustry.key, value: "Rockets" }]);
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("Rockets");
      // The lookup key changing makes the person miss, which is the default and not an error.
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: w.cDomain.key, value: "other.io" }]);
      expect(await cellOf(actor, w.people.id, w.formula.key)).toEqual({ value: "n/a", meta: undefined });
    });

    it("ignores an edit of a source column the formula does not read", async () => {
      const { actor } = await org();
      const w = await world(actor);
      const extra = (await columnsUc.createColumn(deps, actor, w.companies.id, { name: "Employees", type: "text" })).column;
      const version = (await rowsOf(actor, w.people.id))[0].version;
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: extra.key, value: "10" }]);
      expect((await rowsOf(actor, w.people.id))[0].version).toBe(version);
    });

    it("recalculates when source rows are deleted", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await rowsUc.deleteRows(deps, actor, w.companies.id, [w.company.id]);
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("n/a");
    });

    it("shows #REF with the reason when the source column is renamed, and recovers when it is renamed back", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await columnsUc.updateColumn(deps, actor, w.companies.id, w.cIndustry.id, { name: "Sector" });
      const broken = await cellOf(actor, w.people.id, w.formula.key);
      expect(broken.value).toBe("#REF");
      expect(broken.meta).toEqual({ status: "error", code: "REF", error: 'LOOKUP column "Industry" in "Companies" is unknown or ambiguous' });
      await columnsUc.updateColumn(deps, actor, w.companies.id, w.cIndustry.id, { name: "Industry" });
      expect(await cellOf(actor, w.people.id, w.formula.key)).toEqual({ value: "Software", meta: undefined });
    });

    it("shows #REF when the source column is deleted", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await columnsUc.deleteColumn(deps, actor, w.companies.id, w.cIndustry.id);
      const cell = await cellOf(actor, w.people.id, w.formula.key);
      expect(cell.value).toBe("#REF");
      expect(cell.meta).toMatchObject({ status: "error", code: "REF" });
    });

    it("shows #REF when the source table is renamed or deleted", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await structure.updateTable(deps, actor, w.companies.id, { name: "Accounts" });
      expect(await cellOf(actor, w.people.id, w.formula.key)).toMatchObject({ value: "#REF", meta: { code: "REF", error: 'LOOKUP table "Companies" is unknown or ambiguous' } });
      await structure.updateTable(deps, actor, w.companies.id, { name: "Companies" });
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("Software");
      await structure.deleteTable(deps, actor, w.companies.id);
      expect(await cellOf(actor, w.people.id, w.formula.key)).toMatchObject({ value: "#REF", meta: { status: "error", code: "REF" } });
    });

    it("shows #REF when the source table moves to another workbook", async () => {
      const { actor } = await org();
      const w = await world(actor);
      const { workbook: other } = await structure.createWorkbook(deps, actor, { name: "Other" });
      await structure.updateTable(deps, actor, w.companies.id, { workbookId: other.id });
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("#REF");
    });

    it("leaves another organization's formulas alone", async () => {
      const a = await org("a");
      const b = await org("b");
      const wa = await world(a.actor);
      const wb = await world(b.actor);
      const before = (await rowsOf(b.actor, wb.people.id))[0].version;
      await columnsUc.deleteColumn(deps, a.actor, wa.companies.id, wa.cIndustry.id);
      expect((await rowsOf(b.actor, wb.people.id))[0].version).toBe(before);
      expect((await cellOf(b.actor, wb.people.id, wb.formula.key)).value).toBe("Software");
    });
  });

  describe("caps and the stale marker", () => {
    it("marks a formula with auto-run off stale instead of recalculating it", async () => {
      const { actor } = await org();
      const w = await world(actor, { autoRun: false });
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("Software");
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: w.cIndustry.key, value: "Rockets" }]);
      const stale = await cellOf(actor, w.people.id, w.formula.key);
      expect(stale.value).toBe("Software");
      expect(stale.meta).toMatchObject({ status: "stale" });
      expect(String(stale.meta?.error)).toContain('"Companies"');

      const result = await columnsUc.recalculateColumn(deps, actor, w.people.id, w.formula.id);
      expect(result.changedCells).toBe(1);
      expect(await cellOf(actor, w.people.id, w.formula.key)).toEqual({ value: "Rockets", meta: undefined });
    });

    it("recalculates at most the column cap per trigger and marks the rest stale", async () => {
      const { actor } = await org();
      const w = await world(actor);
      const extra: string[] = [];
      for (let i = 0; i < limits.columns + 1; i += 1) extra.push((await columnsUc.createColumn(deps, actor, w.people.id, { name: `Copy ${i}`, type: "formula", config: { expression: w.expression } })).column.key);
      const all = [w.formula.key, ...extra];
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: w.cIndustry.key, value: "Rockets" }]);

      const row = (await rowsOf(actor, w.people.id))[0];
      const fresh = all.filter((key) => row.cells[key] === "Rockets");
      const stale = all.filter((key) => (row.cellMeta[key] as { status?: string } | undefined)?.status === "stale");
      expect(fresh).toHaveLength(limits.columns);
      expect(stale).toHaveLength(all.length - limits.columns);
      for (const key of stale) expect(row.cells[key]).toBe("Software");

      // Recalculate on a stale column refreshes it and clears the marker.
      const staleColumn = (await deps.columns.list(actor.organizationId, w.people.id)).find((c) => c.key === stale[0])!;
      await columnsUc.recalculateColumn(deps, actor, w.people.id, staleColumn.id);
      const after = (await rowsOf(actor, w.people.id))[0];
      expect(after.cells[stale[0]]).toBe("Rockets");
      expect(after.cellMeta[stale[0]]).toBeUndefined();
    });

    it("marks a dependent table over the row cap stale without scanning it", async () => {
      const { actor, id } = await org();
      const w = await world(actor);
      await sql`insert into grid_rows (organization_id, table_id, position, cells, cell_meta)
        select ${id}, ${w.people.id}, 1000 + n, jsonb_build_object(${w.pDomain.key}::text, 'acme.io', ${w.formula.key}::text, 'Software'), '{}'::jsonb from generate_series(1, ${limits.rows + 1}) n`;
      await rowsUc.editCells(deps, actor, w.companies.id, [{ rowId: w.company.id, columnKey: w.cIndustry.key, value: "Rockets" }]);
      const [{ stale, rockets }] = await sql`select count(*) filter (where cell_meta -> ${w.formula.key}::text ->> 'status' = 'stale')::int as stale, count(*) filter (where cells ->> ${w.formula.key}::text = 'Rockets')::int as rockets from grid_rows where table_id = ${w.people.id}`;
      expect(stale).toBe(limits.rows + 2);
      expect(rockets).toBe(0);
    }, 60_000);
  });

  describe("Recalculate action", () => {
    it("refreshes dependents after the source changed behind the app's back", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await sql`update grid_rows set cells = cells || jsonb_build_object(${w.cIndustry.key}::text, 'Rockets') where id = ${w.company.id}`;
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("Software");
      const result = await columnsUc.recalculateColumn(deps, actor, w.people.id, w.formula.id);
      expect(result).toMatchObject({ recalculated: true, changedCells: 1 });
      expect((await cellOf(actor, w.people.id, w.formula.key)).value).toBe("Rockets");
    });

    it("refuses a column that is not a formula, an unknown column and another organization's column", async () => {
      const a = await org("a");
      const b = await org("b");
      const w = await world(a.actor);
      await expect(columnsUc.recalculateColumn(deps, a.actor, w.people.id, w.pDomain.id)).rejects.toBeInstanceOf(ValidationError);
      await expect(columnsUc.recalculateColumn(deps, a.actor, w.people.id, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
      await expect(columnsUc.recalculateColumn(deps, b.actor, w.people.id, w.formula.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("reports a failed source as error cells, not as an empty answer", async () => {
      const { actor } = await org();
      const w = await world(actor);
      await sql`delete from grid_columns where id = ${w.cIndustry.id}`;
      const result = await columnsUc.recalculateColumn(deps, actor, w.people.id, w.formula.id);
      expect(result.changedCells).toBe(1);
      expect(await cellOf(actor, w.people.id, w.formula.key)).toMatchObject({ value: "#REF", meta: { status: "error", code: "REF" } });
    });
  });
});
