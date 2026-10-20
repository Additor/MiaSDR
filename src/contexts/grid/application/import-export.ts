import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { csvLine, UTF8_BOM } from "../domain/csv";
import { buildImportRecords, isInitialSeedColumn, normalizeMapping, planImportColumns, suggestMapping } from "../domain/import-plan";
import type { GridQuery } from "../domain/view-query";
import { refreshAfterSourceWrite } from "./formula-lookup-refresh";
import { recalculateFormulasQuietly } from "./formula-recalc";
import { GRID_LIMITS } from "./limits";
import { queryOf, refsOf } from "./row-management";
import { resolveView } from "./structure-management";
import type { GridDeps } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

export interface ParsedSheet {
  headers: string[];
  /** Data rows only, each as long as `headers`. */
  rows: string[][];
  /** Workbook sheet names in order. Absent for CSV. */
  sheets?: string[];
  /** The 1-based sheet these rows come from. */
  sheet?: number;
  /** Why the chosen sheet cannot be imported (empty, or a header with no data). Headers and rows are empty then. */
  problem?: string;
}

const PREVIEW_ROWS = 10;

function checkSheet(sheet: ParsedSheet): void {
  if (sheet.problem) throw new ValidationError(sheet.problem);
  if (sheet.headers.length === 0) throw new ValidationError("The first row is empty. It should hold the column headers.");
  if (sheet.headers.length > GRID_LIMITS.importColumns) throw new ValidationError(`The file has ${sheet.headers.length} columns. The limit is ${GRID_LIMITS.importColumns}.`);
  if (sheet.rows.length === 0) throw new ValidationError("The file has no data rows.");
  if (sheet.rows.length > GRID_LIMITS.importRows) {
    throw new ValidationError(`The file has ${sheet.rows.length.toLocaleString("en-US")} rows. The limit is ${GRID_LIMITS.importRows.toLocaleString("en-US")}; split it and import in parts.`);
  }
}

/** What an import would do: the first rows, a suggested column mapping and the table's columns. Writes nothing. */
export async function previewImport(deps: Deps, actor: Actor, tableId: string, sheet: ParsedSheet, fileName: string) {
  const table = await deps.structure.getTable(actor.organizationId, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const existing = await deps.columns.list(actor.organizationId, tableId);
  const sheets = sheet.sheets && sheet.sheets.length > 1 ? sheet.sheets : null;
  // With several sheets a bad one is not the end: the preview returns the picker and the reason, and the person chooses another.
  const problem = sheet.problem && sheets ? sheet.problem : null;
  if (!problem) checkSheet(sheet);
  return {
    preview: true as const,
    fileName,
    sheets,
    sheet: sheet.sheet ?? 1,
    problem,
    headers: sheet.headers,
    rows: sheet.rows.slice(0, PREVIEW_ROWS),
    totalRows: sheet.rows.length,
    maxRows: GRID_LIMITS.importRows,
    mapping: problem ? [] : suggestMapping(sheet.headers, sheet.rows, existing),
    columns: existing.map((c) => ({ key: c.key, name: c.name, type: c.type })),
  };
}

/**
 * Creates the mapped columns and inserts the rows in one transaction. A fresh table's empty first row
 * and "New Column" are replaced instead of kept. Text that starts with an apostrophe before a formula
 * character is restored, so a file this grid exported reads back unchanged.
 */
export async function runImport(deps: Deps, actor: Actor, tableId: string, sheet: ParsedSheet, rawMapping: unknown) {
  const table = await deps.structure.getTable(actor.organizationId, tableId);
  if (!table) throw new NotFoundError("Table not found");
  checkSheet(sheet);
  const existing = await deps.columns.list(actor.organizationId, tableId);
  const mapping = normalizeMapping(rawMapping, sheet.headers, new Set(existing.map((c) => c.key)));
  if (!mapping.some((m) => m.action !== "skip")) throw new ValidationError("Every column is set to skip");

  const result = await deps.rows.importRecords(
    actor.organizationId,
    tableId,
    ({ columns, canReuseSeed }) => {
      const reuse = canReuseSeed && isInitialSeedColumn(columns);
      // The store validated the seed against the live table; the plan decides which new column takes its place.
      const plan = planImportColumns(mapping, columns, { canReuseSeedColumn: reuse });
      return { newColumns: plan.newColumns, records: buildImportRecords(sheet.rows, plan) };
    },
    { maxRows: GRID_LIMITS.tableRows, maxColumns: GRID_LIMITS.columnsPerTable },
  );
  if (!result) throw new NotFoundError("Table not found");
  if (result.rowsInserted > 0) {
    const after = await deps.columns.list(actor.organizationId, tableId);
    if (after.some((c) => c.type === "formula")) await recalculateFormulasQuietly(deps, actor.organizationId, tableId, { changedKeys: after.map((c) => c.key) });
    await refreshAfterSourceWrite(deps, actor.organizationId, table);
  }
  return { preview: false as const, rowsInserted: result.rowsInserted, columnsCreated: result.columnsCreated };
}

export interface ExportInput {
  /** Rows in the order given. Omit to export the whole table in table order. */
  rowIds?: string[];
  columnKeys?: string[];
  /**
   * Export what this member sees: their merged view (default plus personal filters and sorts) and `search`.
   * The client sends no filters. Ignored when `rowIds` is set, which already names the rows.
   */
  useView?: boolean;
  /** The grid's search box. Applies on its own or together with `useView`. */
  search?: string;
}

export function exportFilename(tableName: string, rowCount: number): string {
  const slug =
    tableName
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "table";
  return `${slug}-${rowCount}-rows.csv`;
}

/**
 * The CSV as text chunks: BOM and header first, then one chunk per batch of rows. Cells that a
 * spreadsheet would run as a formula get a leading apostrophe. Validation happens before the first chunk.
 */
export async function exportTableCsv(deps: Deps, actor: Actor, tableId: string, input: ExportInput = {}) {
  const org = actor.organizationId;
  const [table, allColumns] = await Promise.all([deps.structure.getTable(org, tableId), deps.columns.list(org, tableId)]);
  if (!table) throw new NotFoundError("Table not found");

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  let columns = allColumns;
  if (input.columnKeys !== undefined) {
    if (input.columnKeys.length === 0 || new Set(input.columnKeys).size !== input.columnKeys.length) throw new ValidationError("columnKeys must be a non-empty list without repeats");
    columns = input.columnKeys.map((key) => {
      const column = byKey.get(key);
      if (!column) throw new ValidationError(`Unknown column: ${key}`);
      return column;
    });
  }

  let rowCount: number;
  let query: GridQuery | undefined;
  let refs: ReturnType<typeof refsOf> = [];
  if (input.rowIds !== undefined) {
    const ids = input.rowIds;
    if (ids.length === 0) throw new ValidationError("rowIds must be a non-empty array");
    if (ids.length > GRID_LIMITS.exportRows) throw new ValidationError(`rowIds cannot contain more than ${GRID_LIMITS.exportRows.toLocaleString("en-US")} values`);
    if (new Set(ids).size !== ids.length) throw new ValidationError("rowIds must contain unique values");
    if ((await deps.rows.countByIds(org, tableId, ids)) !== ids.length) throw new ValidationError("One or more rows do not belong to this table");
    rowCount = ids.length;
  } else {
    if (input.useView || input.search?.trim()) {
      const view = input.useView ? (await resolveView(deps, actor, table, allColumns)).view : {};
      query = queryOf(view, input.search);
      refs = refsOf(allColumns);
    }
    rowCount = await deps.rows.count(org, tableId, query ? { query, columns: refs } : undefined);
    if (rowCount > GRID_LIMITS.exportRows) {
      throw new ValidationError(`${query ? "The view matches" : "The table has"} more than ${GRID_LIMITS.exportRows.toLocaleString("en-US")} rows. Export a selection instead.`);
    }
  }

  const cellsOf = (row: { cells: Record<string, unknown> }) => csvLine(columns.map((c) => row.cells?.[c.key]));

  async function* chunks(): AsyncGenerator<string> {
    yield UTF8_BOM + csvLine(columns.map((c) => c.name));
    if (input.rowIds !== undefined) {
      const ids = input.rowIds;
      for (let i = 0; i < ids.length; i += 1000) {
        const slice = ids.slice(i, i + 1000);
        const byId = new Map((await deps.rows.listByIds(org, tableId, slice)).map((r) => [r.id, r]));
        yield slice.map((id) => (byId.has(id) ? cellsOf(byId.get(id)!) : "")).join("");
      }
      return;
    }
    for await (const batch of deps.rows.scan(org, tableId, { batch: 1000, query, columns: refs })) yield batch.map(cellsOf).join("");
  }

  return { filename: exportFilename(table.name, rowCount), rowCount, chunks: chunks() };
}
