import { strToU8, zipSync } from "fflate";
import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { signInAs, tick } from "./fixtures";

export interface GridColumnJson {
  id: string;
  key: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface GridRowJson {
  id: string;
  version: number;
  cells: Record<string, unknown>;
  cellMeta: Record<string, { status?: string; error?: string } | undefined>;
}

export interface GridPageJson {
  columns: GridColumnJson[];
  rows: GridRowJson[];
  total: number;
  unfilteredTotal: number;
  view: Record<string, unknown>;
  personalView?: boolean;
}

/** Creates a workbook with one table through the API and returns both ids. */
export async function newWorkbook(request: APIRequestContext, name: string): Promise<{ workbookId: string; tableId: string }> {
  const created = await request.post("/api/grid/workbooks", { data: { name } });
  expect(created.status(), "create workbook").toBe(201);
  const body = (await created.json()) as { id?: string; workbook?: { id: string } };
  const workbookId = (body.workbook?.id ?? body.id) as string;
  const detail = await request.get(`/api/grid/workbooks/${workbookId}`);
  expect(detail.status()).toBe(200);
  const { tables } = (await detail.json()) as { tables: Array<{ id: string }> };
  return { workbookId, tableId: tables[0].id };
}

export async function gridPage(request: APIRequestContext, tableId: string): Promise<GridPageJson> {
  const res = await request.get(`/api/grid/tables/${tableId}?limit=200`);
  expect(res.status(), "load table").toBe(200);
  return (await res.json()) as GridPageJson;
}

/** Imports a CSV through the same two calls as the wizard: a preview for the suggested mapping, then the import. */
export async function importCsv(request: APIRequestContext, tableId: string, table: string[][]): Promise<void> {
  const file = { name: "c2.csv", mimeType: "text/csv", buffer: Buffer.from(table.map((r) => r.join(",")).join("\n")) };
  const preview = await request.post(`/api/grid/tables/${tableId}/import`, { multipart: { file } });
  expect(preview.status(), "import preview").toBe(200);
  const { mapping } = (await preview.json()) as { mapping: unknown };
  const done = await request.post(`/api/grid/tables/${tableId}/import`, { multipart: { file, mapping: JSON.stringify(mapping) } });
  expect(done.status(), "import").toBe(200);
}

/** The cell value of the first row whose `byColumn` equals `byValue`, read through the API. */
export async function cellValue(request: APIRequestContext, tableId: string, byColumn: string, byValue: string, column: string): Promise<unknown> {
  const page = await gridPage(request, tableId);
  const key = (name: string) => page.columns.find((c) => c.name === name)?.key ?? name;
  return page.rows.find((r) => r.cells[key(byColumn)] === byValue)?.cells[key(column)];
}

/** Writes one cell without a version, the way another person's edit lands while a stale tab is open. */
export async function writeCell(request: APIRequestContext, tableId: string, rowId: string, columnKey: string, value: unknown): Promise<void> {
  const res = await request.patch(`/api/grid/tables/${tableId}/cells`, { data: { rowId, columnKey, value } });
  expect(res.status(), "write cell").toBe(200);
}

/**
 * A second browser context signed in as `email`, with its own console and request watcher.
 * `done()` closes it and fails on a console error or a failed request, except the ones named in `allow`.
 */
export async function secondBrowser(browser: Browser, email: string, password: string, allow: RegExp[] = []): Promise<{ page: Page; done: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems: string[] = [];
  const record = (text: string) => {
    if (!allow.some((re) => re.test(text))) problems.push(text);
  };
  page.on("console", (m) => m.type() === "error" && record(`console.error: ${m.text()}`));
  page.on("pageerror", (e) => record(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => r.failure()?.errorText !== "net::ERR_ABORTED" && record(`requestfailed: ${r.method()} ${r.url()}`));
  page.on("response", (r) => r.status() >= 400 && record(`response ${r.status()}: ${r.request().method()} ${r.url()}`));
  await signInAs(page, email, password);
  return {
    page,
    done: async () => {
      await page.goto("about:blank");
      await context.close();
      expect(problems, `console errors and failed requests of ${email}'s browser`).toEqual([]);
    },
  };
}

const colName = (i: number) => String.fromCharCode(65 + (i % 26)).repeat(Math.floor(i / 26) + 1);
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A minimal one-sheet workbook with shared strings and numbers, enough for the import wizard. */
export function xlsxFile(name: string, rows: Array<Array<string | number>>) {
  const shared: string[] = [];
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
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
  const bytes = zipSync({
    "[Content_Types].xml": xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/sharedStrings.xml": xml(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}</sst>`),
  });
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(bytes) };
}

export interface JobCounts {
  queued: number;
  running: number;
  waiting: number;
  succeeded: number;
  failed: number;
}

export async function jobCounts(request: APIRequestContext, tableId: string): Promise<JobCounts> {
  const res = await request.get(`/api/grid/tables/${tableId}/run`);
  expect(res.status(), "run status").toBe(200);
  return (await res.json()) as JobCounts;
}

/** Ticks the job runner until the table has no queued, running or waiting cells. */
export async function settle(request: APIRequestContext, tableId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await tick(request);
        const c = await jobCounts(request, tableId);
        return c.queued + c.running + c.waiting;
      },
      { message: "grid jobs settle", timeout: 30_000 },
    )
    .toBe(0);
}
