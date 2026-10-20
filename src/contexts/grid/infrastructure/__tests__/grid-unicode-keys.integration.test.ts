import { afterAll, beforeAll, expect, it } from "vitest";
import type { GridDeps } from "../../application/ports";
import { render } from "../../domain/enrichment-templates";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "./grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("non-ASCII column keys", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let deps: GridDeps;
  let structure: typeof import("../../application/structure-management");
  let columnsUc: typeof import("../../application/column-management");
  let rowsUc: typeof import("../../application/row-management");
  let io: typeof import("../../application/import-export");
  let handoffUc: typeof import("../../application/campaign-handoff");
  let parseUpload: typeof import("../parse-upload").parseUpload;

  async function org() {
    const { organizationId: id, userId } = await gridOrg(sql, orgs, "member", "ku");
    return { id, actor: { userId, organizationId: id, role: "member" } as Actor };
  }

  const rowsOf = async (actor: Actor, tableId: string) => (await rowsUc.getTablePage(deps, actor, tableId, { limit: 1000 })).rows;

  async function importKorean(actor: Actor, tableId: string, csv: string) {
    const sheet = await parseUpload({ name: "k.csv", bytes: Buffer.from(csv, "utf8") });
    const preview = await io.previewImport(deps, actor, tableId, sheet, "k.csv");
    await io.runImport(deps, actor, tableId, sheet, preview.mapping);
  }

  useTestEnv();

  beforeAll(async () => {
    deps = (await import("../composition")).gridDeps();
    structure = await import("../../application/structure-management");
    columnsUc = await import("../../application/column-management");
    rowsUc = await import("../../application/row-management");
    io = await import("../../application/import-export");
    handoffUc = await import("../../application/campaign-handoff");
    parseUpload = (await import("../parse-upload")).parseUpload;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("imports Korean headers with readable keys, then resolves them in a formula, a prompt template, the CSV export and the campaign push", async () => {
    const { actor } = await org();
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "회사" });
    await importKorean(actor, table.id, "회사 이름,업종,Email\n에이콤,소프트웨어,a@acme.test\n");

    const page = await rowsUc.getTablePage(deps, actor, table.id);
    expect(page.columns.map((c) => [c.key, c.name])).toEqual([
      ["회사이름", "회사 이름"],
      ["업종", "업종"],
      ["email", "Email"],
    ]);
    expect(page.rows[0].cells).toMatchObject({ 회사이름: "에이콤", 업종: "소프트웨어" });

    // Formula column.
    const { column: formula } = await columnsUc.createColumn(deps, actor, table.id, { name: "Label", type: "formula", config: { expression: '{{회사이름}} & " / " & {{업종}}' } });
    const row = (await rowsOf(actor, table.id))[0];
    expect(row.cells[formula.key]).toBe("에이콤 / 소프트웨어");

    // AI prompt template reads the same keys.
    expect(render("Write about {{회사이름}} in {{업종}}", row.cells)).toBe("Write about 에이콤 in 소프트웨어");

    // CSV export shows the labels.
    const { chunks } = await io.exportTableCsv(deps, actor, table.id);
    let text = "";
    for await (const chunk of chunks) text += chunk;
    expect(text.split("\r\n")[0].replace("﻿", "")).toBe("회사 이름,업종,Email,Label");

    // Campaign push passes the label next to the key.
    let captured: { columns: Array<{ key: string; name: string }>; customColumnKeys: string[] } | undefined;
    const spy = {
      ...deps,
      handoff: {
        push: async (input: { columns: Array<{ key: string; name: string }>; customColumnKeys: string[] }) => {
          captured = input;
          return { created: 0, updated: 0, skipped: 0, failures: [] };
        },
      },
    } as unknown as GridDeps;
    await handoffUc.pushToCampaign(spy, actor, table.id, { rowIds: [row.id], target: { newCampaignName: "x" }, fields: { email: "email" }, customColumnKeys: ["업종"] });
    expect(captured?.customColumnKeys).toEqual(["업종"]);
    expect(captured?.columns.find((c) => c.key === "업종")?.name).toBe("업종");
    expect(captured?.columns.find((c) => c.key === "회사이름")?.name).toBe("회사 이름");
  });

  it("looks a row up across tables whose keys are Korean", async () => {
    const { actor } = await org();
    const { workbook, table: people } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "People" });
    const { table: companies } = await structure.createTable(deps, actor, { workbookId: workbook.id, name: "Companies" });
    await importKorean(actor, companies.id, "도메인,업종\nacme.io,소프트웨어\n");
    await importKorean(actor, people.id, "도메인\nacme.io\n");
    await columnsUc.createColumn(deps, actor, people.id, { name: "Industry", type: "formula", config: { expression: 'LOOKUP("Companies", {{도메인}}, "도메인", "업종", "n/a")' } });
    const [person] = await rowsOf(actor, people.id);
    expect(person.cells.industry).toBe("소프트웨어");
  });

  it("keeps two Korean-only headers distinct instead of column, column2", async () => {
    const { actor } = await org();
    const { table } = await structure.createWorkbook(deps, actor, { name: "W", firstTableName: "T" });
    await importKorean(actor, table.id, "이름,직함\n민수,팀장\n");
    const page = await rowsUc.getTablePage(deps, actor, table.id);
    expect(page.columns.map((c) => c.key)).toEqual(["이름", "직함"]);
  });
});
