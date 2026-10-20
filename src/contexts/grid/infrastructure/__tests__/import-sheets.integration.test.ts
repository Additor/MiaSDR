import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";
import { makeXlsx } from "@/test-support/xlsx-fixture";
import type { GridDeps } from "../../application/ports";

/** Import preview and import read the sheet that was chosen. */
describeDb("grid import with sheets", () => {
  const sql = testSql({ max: 3 });
  useTestEnv();
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let io: typeof import("../../application/import-export");
  let parseUpload: typeof import("../parse-upload").parseUpload;

  async function setup() {
    const { organizationId: org, actor } = await gridOrg(sql, orgs, "member");
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    return { org, actor, tableId: table.id };
  }

  const threeSheets = () =>
    Buffer.from(
      makeXlsx([["Email", "Name"], ["one@acme.com", "Ada"]], {
        secondSheet: [["Company", "회사 규모"], ["Acme", "51-200"], ["Globex", "1-10"]],
        secondName: "Companies",
        moreSheets: [{ name: "Empty", rows: [] }],
      }),
    );

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    io = await import("../../application/import-export");
    parseUpload = (await import("../parse-upload")).parseUpload;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("previews sheet 1 by default and lists all three sheets", async () => {
    const { actor, tableId } = await setup();
    const preview = await io.previewImport(deps, actor, tableId, await parseUpload({ name: "book.xlsx", bytes: threeSheets() }), "book.xlsx");
    expect(preview.sheets).toEqual(["Leads", "Companies", "Empty"]);
    expect(preview.sheet).toBe(1);
    expect(preview.headers).toEqual(["Email", "Name"]);
    expect(preview.totalRows).toBe(1);
  });

  it("previews and imports sheet 2 when it is chosen", async () => {
    const { org, actor, tableId } = await setup();
    const sheet = await parseUpload({ name: "book.xlsx", bytes: threeSheets() }, { sheet: 2 });
    const preview = await io.previewImport(deps, actor, tableId, sheet, "book.xlsx");
    expect(preview.sheet).toBe(2);
    expect(preview.headers).toEqual(["Company", "회사 규모"]);
    expect(preview.totalRows).toBe(2);
    const result = await io.runImport(deps, actor, tableId, sheet, preview.mapping);
    expect(result.rowsInserted).toBe(2);
    const columns = await deps.columns.list(org, tableId);
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["Company", "회사 규모"]));
    expect(columns.map((c) => c.name)).not.toContain("Email");
  });

  it("keeps the picker for an empty sheet and refuses to import it", async () => {
    const { actor, tableId } = await setup();
    const sheet = await parseUpload({ name: "book.xlsx", bytes: threeSheets() }, { sheet: 3 });
    const preview = await io.previewImport(deps, actor, tableId, sheet, "book.xlsx");
    expect(preview.problem).toBe('Sheet "Empty" is empty.');
    expect(preview.sheets).toEqual(["Leads", "Companies", "Empty"]);
    expect(preview.mapping).toEqual([]);
    await expect(io.runImport(deps, actor, tableId, sheet, [{ headerIndex: 0, action: "skip" }])).rejects.toThrow(/is empty/);
  });

  it("reports sheets as null for CSV and refuses an empty single sheet as before", async () => {
    const { actor, tableId } = await setup();
    const csv = await io.previewImport(deps, actor, tableId, await parseUpload({ name: "a.csv", bytes: Buffer.from("Email,Name\na@acme.com,Ada\n") }), "a.csv");
    expect(csv.sheets).toBeNull();
    expect(csv.sheet).toBe(1);
    const single = Buffer.from(makeXlsx([]));
    await expect(io.previewImport(deps, actor, tableId, await parseUpload({ name: "one.xlsx", bytes: single }), "one.xlsx")).rejects.toThrow(/first sheet is empty/);
  });
});
