import { strToU8, zipSync } from "fflate";
import { csvFile, expect, signInAdmin, test } from "./support/fixtures";
import { gridPage, newWorkbook } from "./support/grid";
import { seedGrid } from "./support/grid-seed";

/** Tables, workbooks, import and export, including the export view and the sheet picker of the import wizard. */

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colName = (i: number) => String.fromCharCode(65 + (i % 26));

/** A workbook with one sheet per entry, text and numbers only. Sheet names appear in the picker in this order. */
function workbookFile(name: string, sheets: Array<{ name: string; rows: Array<Array<string | number>> }>) {
  const shared: string[] = [];
  const sheetXml = (rows: Array<Array<string | number>>) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) => {
              const ref = `${colName(c)}${r + 1}`;
              if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
              shared.push(cell);
              return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`;
  const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet.rows))));
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const bytes = zipSync({
    "[Content_Types].xml": xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    ...files,
    "xl/sharedStrings.xml": xml(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}</sst>`),
  });
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(bytes) };
}

test.describe("grid tables: export and import", () => {
  test("Export follows the default view, the member's own view and the search box", async ({ page }) => {
    await signInAdmin(page);
    const seeded = await seedGrid(page.request, { rows: 120, name: "S28 export view" });
    const score = seeded.keys.Score;
    const cond = (operator: string, value: string) => ({ conjunction: "and", conditions: [{ columnKey: score, operator, value }] });

    const exportCsv = async () => {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export CSV" }).click();
      const file = await download;
      const stream = await file.createReadStream();
      let text = "";
      for await (const chunk of stream) text += chunk.toString("utf8");
      const lines = text.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "");
      return { filename: file.suggestedFilename(), header: lines[0], rows: lines.slice(1) };
    };

    // The default view keeps the first 40 rows.
    const saved = await page.request.patch(`/api/grid/tables/${seeded.tableId}`, { data: { view: { filters: cond("lte", "40") } } });
    expect(saved.status(), "save the default view").toBe(200);
    await page.goto(`/tables/${seeded.workbookId}`);
    await expect(page.getByText("40 rows of 120")).toBeVisible();
    const byDefault = await exportCsv();
    expect(byDefault.filename).toMatch(/-40-rows\.csv$/);
    expect(byDefault.header.startsWith("Name,Email")).toBe(true);
    expect(byDefault.rows).toHaveLength(40);
    expect(byDefault.rows[0]).toContain("Person 1,");
    expect(byDefault.rows[39]).toContain("Person 40,");

    // The member's own view replaces the filter and sorts the other way. The page loads it; the export has to match without being told.
    const mine = await page.request.put(`/api/grid/tables/${seeded.tableId}/view`, { data: { view: { filters: cond("gt", "110"), sorts: [{ columnKey: score, direction: "desc" }] } } });
    expect(mine.status(), "save my view").toBe(200);
    expect((await gridPage(page.request, seeded.tableId)).total).toBe(10);
    await page.reload();
    await expect(page.getByText("10 rows of 120")).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Name: Person 120", exact: true })).toBeVisible();
    const personal = await exportCsv();
    expect(personal.filename).toMatch(/-10-rows\.csv$/);
    expect(personal.rows.map((r) => r.split(",")[0])).toEqual(Array.from({ length: 10 }, (_, i) => `Person ${120 - i}`));

    // The search box narrows the same view: 111 to 119 contain "Person 11".
    await page.getByLabel("Search rows").fill("Person 11");
    await expect(page.getByText("9 rows of 120")).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Name: Person 119", exact: true })).toBeVisible();
    const searched = await exportCsv();
    expect(searched.filename).toMatch(/-9-rows\.csv$/);
    expect(searched.rows.map((r) => r.split(",")[0])).toEqual(Array.from({ length: 9 }, (_, i) => `Person ${119 - i}`));
  });

  test("The import wizard offers the sheets of a workbook and imports the one that is chosen", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "S28 sheet picker");
    await page.goto(`/tables/${workbookId}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import file" }).click();
    await page.getByLabel("File to import").setInputFiles(
      workbookFile("g2-three-sheets.xlsx", [
        { name: "Leads", rows: [["Email", "Name"], ["a@g2-sheets.test", "Ada"]] },
        { name: "Companies", rows: [["Company", "회사 규모", "Seats"], ["Acme", "51-200", 12], ["Globex", "1-10", 40]] },
        { name: "Cover", rows: [] },
      ]),
    );
    const dialog = page.getByRole("dialog", { name: "Import a file" });

    // Sheet 1 is the default.
    await expect(dialog.getByText("1 row, 2 columns.")).toBeVisible();
    await expect(dialog.getByText("3 sheets in this file")).toBeVisible();
    await expect(dialog.getByText("a@g2-sheets.test")).toBeVisible();

    // An empty sheet keeps the picker, explains itself and blocks the import.
    await dialog.getByRole("combobox", { name: "Sheet to import" }).click();
    await page.getByRole("option", { name: "Cover" }).click();
    await expect(dialog.getByRole("alert").filter({ hasText: 'Sheet "Cover" is empty.' })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Import/ })).toBeDisabled();

    // Sheet 2 re-runs the preview and the mapping.
    await dialog.getByRole("combobox", { name: "Sheet to import" }).click();
    await page.getByRole("option", { name: "Companies" }).click();
    await expect(dialog.getByText("2 rows, 3 columns.")).toBeVisible();
    await expect(dialog.getByText("Globex")).toBeVisible();
    await expect(dialog.getByText("a@g2-sheets.test")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(page.getByText(/Imported 2 rows/)).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Company: Globex", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "회사 규모: 51-200", exact: true })).toBeVisible();

    const data = await gridPage(page.request, tableId);
    expect(data.total).toBe(2);
    expect(data.columns.map((c) => c.name)).not.toContain("Email");
  });

  test("Add rows adds up to 1,000 blank rows and scrolls to the end", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "S28 add rows");
    await page.goto(`/tables/${workbookId}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add rows..." }).click();
    const dialog = page.getByRole("dialog", { name: "Add rows" });

    // The field refuses what the server refuses, with a reason, and keeps the button off.
    await dialog.getByLabel("Number of rows").fill("1001");
    await expect(dialog.getByRole("alert")).toHaveText("Add at most 1,000 rows at a time.");
    await expect(dialog.getByRole("button", { name: "Add rows" })).toBeDisabled();
    await dialog.getByLabel("Number of rows").fill("250");
    await dialog.getByRole("button", { name: "Add 250 rows" }).click();
    await expect(page.getByText("Added 250 rows.")).toBeVisible();
    await expect(page.getByText("251 rows", { exact: true })).toBeVisible();
    expect((await gridPage(page.request, tableId)).total).toBe(251);

    // The grid scrolled down: the first row is out of the window and the last row is in it.
    await expect.poll(() => page.getByRole("grid").evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
    await expect(page.getByRole("row", { name: /^251\b/ }).or(page.locator('[role="row"][aria-rowindex="252"]'))).toBeVisible();
  });

  test("Duplicate column copies a data column's values and a formula's expression", async ({ page }) => {
    await signInAdmin(page);
    const seeded = await seedGrid(page.request, { rows: 30, name: "S28 duplicate column" });
    await page.goto(`/tables/${seeded.workbookId}`);

    await page.getByRole("button", { name: "Column menu for 회사" }).click();
    await page.getByRole("menuitem", { name: "Duplicate column" }).click();
    await expect(page.getByText('Duplicated "회사".')).toBeVisible();
    let data = await gridPage(page.request, seeded.tableId);
    const names = data.columns.map((c) => c.name);
    expect(names.indexOf("회사 (copy)")).toBe(names.indexOf("회사") + 1);
    const copy = data.columns.find((c) => c.name === "회사 (copy)")!;
    expect(data.rows[3].cells[copy.key]).toBe("회사 3");
    await expect(page.getByRole("gridcell", { name: "회사 (copy): 회사 3", exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Column menu for Score x2" }).click();
    await page.getByRole("menuitem", { name: "Duplicate column" }).click();
    await expect(page.getByText('Duplicated "Score x2".')).toBeVisible();
    data = await gridPage(page.request, seeded.tableId);
    const formulaCopy = data.columns.find((c) => c.name === "Score x2 (copy)")!;
    expect(formulaCopy.type).toBe("formula");
    expect(Number(data.rows[4].cells[formulaCopy.key])).toBe(10);
  });

  test("The table menu edits the description and moves a table to another workbook", async ({ page }) => {
    await signInAdmin(page);
    const a = await newWorkbook(page.request, "S28 move from");
    const b = await newWorkbook(page.request, "S28 move to");
    const made = await page.request.post("/api/grid/tables", { data: { workbookId: a.workbookId, name: "Mover" } });
    expect(made.status()).toBe(201);
    await page.goto(`/tables/${a.workbookId}`);
    const tabs = page.getByRole("tablist", { name: "Tables" }).getByRole("tab");
    await expect(tabs).toHaveText(["Custom Table", "Mover"]);

    await page.getByRole("button", { name: "Actions for Mover" }).click();
    await page.getByRole("menuitem", { name: "Edit description" }).click();
    await page.getByRole("textbox", { name: "Description" }).fill("Leads from the May webinar");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("tab", { name: "Mover" }).click();
    await expect(page.getByTestId("table-description")).toHaveText("Leads from the May webinar");
    await page.reload();
    await expect(page.getByTestId("table-description")).toHaveText("Leads from the May webinar");

    await page.getByRole("button", { name: "Actions for Mover" }).click();
    await page.getByRole("menuitem", { name: "Move to workbook" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Destination workbook" }).click();
    await page.getByRole("option", { name: /^S28 move to/ }).click();
    await dialog.getByRole("button", { name: "Move table" }).click();
    await expect(page.getByText('Moved "Mover" to "S28 move to".')).toBeVisible();
    // The page follows the table: the URL names the destination workbook and the moved table, which is the open tab.
    await expect(page).toHaveURL(new RegExp(`/tables/${b.workbookId}\\?table=`));
    await expect(tabs).toHaveText(["Custom Table", "Mover"]);
    await expect(page.getByRole("tab", { name: "Mover" })).toHaveAttribute("aria-selected", "true");
    // The last table of a workbook cannot leave it, so the menu item is off.
    await page.goto(`/tables/${a.workbookId}`);
    await page.getByRole("button", { name: "Actions for Custom Table" }).click();
    await expect(page.getByRole("menuitem", { name: "Move to workbook" })).toHaveAttribute("aria-disabled", "true");
  });

  test("A new workbook can start from a file and opens its mapping step", async ({ page }) => {
    await signInAdmin(page);
    await seedGrid(page.request, { rows: 2, name: "S28 file host" });
    await page.goto("/tables");
    // The file input has no click to wait on, so wait for the list to load, which means the page is hydrated.
    await expect(page.getByRole("link", { name: "S28 file host" })).toBeVisible();
    await page.getByLabel("Spreadsheet file to start from").setInputFiles(csvFile("g2-from-file.csv", [["Email", "Company"], ["ada@g2-file.test", "Acme"], ["bo@g2-file.test", "Globex"]]));
    const dialog = page.getByRole("dialog", { name: "Import a file" });
    await expect(dialog.getByText("2 rows, 2 columns.")).toBeVisible();
    await expect(dialog.getByText("ada@g2-file.test")).toBeVisible();
    await dialog.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(page).toHaveURL(/\/tables\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: "g2-from-file" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Company: Globex", exact: true })).toBeVisible();
  });

  test("Cancelling the mapping of a new workbook from a file removes the empty workbook again", async ({ page }) => {
    await signInAdmin(page);
    // Its own data, so the test does not depend on the others in this file.
    await seedGrid(page.request, { rows: 2, name: "S28 cancel host" });
    const workbookNames = async () => {
      const res = await page.request.get("/api/grid/workbooks");
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { workbooks: Array<{ name: string }> }).workbooks.map((w) => w.name);
    };
    await page.goto("/tables");
    // The file input has no click to wait on, so wait for the list to load, which means the page is hydrated.
    await expect(page.getByRole("link", { name: "S28 cancel host" })).toBeVisible();
    await page.getByLabel("Spreadsheet file to start from").setInputFiles(csvFile("g2-cancelled.csv", [["Email"], ["x@g2-file.test"]]));
    await expect(page.getByRole("dialog", { name: "Import a file" }).getByText("1 row, 1 column.")).toBeVisible();
    // The workbook exists before the mapping step shows. Without this the check below would also pass if it never did.
    await expect.poll(workbookNames).toContain("g2-cancelled");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The delete is a request after the click; the list on screen does not prove it ran.
    await expect.poll(workbookNames, { timeout: 15_000 }).not.toContain("g2-cancelled");
    expect(await workbookNames()).toContain("S28 cancel host");
  });
});
