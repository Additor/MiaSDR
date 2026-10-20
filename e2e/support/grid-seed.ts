import { expect, type APIRequestContext } from "@playwright/test";
import { gridPage, newWorkbook } from "./grid";

/** Column names of a seeded table, in order. The Korean header exercises non-ASCII names in the grid and in selectors. */
export const SEED_HEADERS = ["Name", "Email", "Score", "Joined", "Active", "Site", "회사"] as const;

const SEED_TYPES: Record<(typeof SEED_HEADERS)[number], string> = {
  Name: "text",
  Email: "email",
  Score: "number",
  Joined: "date",
  Active: "boolean",
  Site: "url",
  회사: "text",
};

export interface SeededGrid {
  workbookId: string;
  tableId: string;
  rows: number;
  /** Column key by column name, formula column included. */
  keys: Record<string, string>;
  /** The values written for row `i` (0-based), so a test can assert without reading them back. */
  expected: (i: number) => Record<(typeof SEED_HEADERS)[number], string>;
}

/** What row `i` holds. Deterministic, so two runs seed the same table. No commas, quotes or newlines. */
export function seedRow(i: number): Record<(typeof SEED_HEADERS)[number], string> {
  return {
    Name: `Person ${i + 1}`,
    Email: `person${i + 1}@seed.test`,
    Score: String(i + 1),
    Joined: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    Active: i % 2 === 0 ? "true" : "false",
    Site: `https://seed.test/${i + 1}`,
    회사: `회사 ${i % 7}`,
  };
}

export interface SeedOptions {
  /** Rows to write, 1 to 10,000 (the import cap). */
  rows: number;
  /** Workbook name. Defaults to a name that includes the row count. */
  name?: string;
  /** Adds `Score x2`, a formula column `{{Score}} * 2`. Default true. */
  formula?: boolean;
}

/**
 * Creates a workbook with one grid table holding `rows` rows of every common static type
 * (text, email, number, date, boolean, url, a Korean-named text column) and a formula column.
 * It goes through the same two import calls as the wizard, then the columns API, so it needs no database access
 * and works against any E2E build. Sign in first: the request context carries the session.
 */
export async function seedGrid(request: APIRequestContext, options: SeedOptions): Promise<SeededGrid> {
  const { rows } = options;
  expect(rows, "seed row count").toBeGreaterThanOrEqual(1);
  expect(rows, "seed row count").toBeLessThanOrEqual(10_000);
  const { workbookId, tableId } = await newWorkbook(request, options.name ?? `Seed ${rows} rows`);

  const lines = [SEED_HEADERS.join(",")];
  for (let i = 0; i < rows; i++) lines.push(SEED_HEADERS.map((h) => seedRow(i)[h]).join(","));
  const file = { name: "seed.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) };

  const preview = await request.post(`/api/grid/tables/${tableId}/import`, { multipart: { file } });
  expect(preview.status(), "seed import preview").toBe(200);
  const { headers, mapping } = (await preview.json()) as { headers: string[]; mapping: Array<{ headerIndex: number; action: string; type?: string }> };
  const typed = mapping.map((m) => (m.action === "create" ? { ...m, type: SEED_TYPES[headers[m.headerIndex] as keyof typeof SEED_TYPES] ?? m.type } : m));
  const done = await request.post(`/api/grid/tables/${tableId}/import`, { multipart: { file, mapping: JSON.stringify(typed) } });
  expect(done.status(), "seed import").toBe(200);

  let page = await gridPage(request, tableId);
  const keys = Object.fromEntries(page.columns.map((c) => [c.name, c.key]));
  if (options.formula !== false) {
    const added = await request.post(`/api/grid/tables/${tableId}/columns`, { data: { name: "Score x2", type: "formula", config: { expression: `{{${keys.Score}}} * 2` } } });
    expect(added.status(), "seed formula column").toBe(201);
    page = await gridPage(request, tableId);
    Object.assign(keys, Object.fromEntries(page.columns.map((c) => [c.name, c.key])));
  }
  expect(page.unfilteredTotal, "seeded row count").toBe(rows);
  return { workbookId, tableId, rows, keys, expected: seedRow };
}
