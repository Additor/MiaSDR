import { isStaticColumnType } from "@/contexts/grid/domain/column-types";
import { neutralizeFormula, restoreFormula } from "@/contexts/grid/domain/csv";
import { editorText } from "../view/format";
import type { Bounds } from "../view/selection";
import type { CellEditInput, GridColumn, GridRow } from "../data/types";

/**
 * Parses clipboard text from a spreadsheet: tab separated, rows split on newlines, cells wrapped in double
 * quotes when they hold tabs, quotes or line breaks. One trailing line break (Excel adds it) is dropped.
 */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStart = true;
  const source = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cellStart) {
      quoted = true;
      cellStart = false;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
      cellStart = true;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStart = true;
    } else {
      cell += ch;
      cellStart = false;
    }
  }
  if (cell !== "" || row.length > 0 || rows.length === 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * The clipboard text of one cell. Text that a spreadsheet would run as a formula (`=1+1`, `-x`, `@cmd`) gets the
 * apostrophe the CSV export uses, so pasting into Sheets or Excel shows it as typed. Numbers and booleans are not
 * text, so `-5` stays `-5`.
 */
export function clipboardCell(value: unknown): string {
  return typeof value === "string" ? neutralizeFormula(value) : editorText(value);
}

/** The inverse of parseClipboard: what goes on the clipboard when a range is copied. */
export function serializeClipboard(matrix: readonly (readonly string[])[]): string {
  return matrix
    .map((row) => row.map((cell) => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join("\t"))
    .join("\n");
}

export interface PastePlan {
  updates: CellEditInput[];
  /** Cells in columns that are not typed in (formula, AI, enrichment and their outputs). Includes `skippedFormula`. */
  skippedRunner: number;
  /** The part of `skippedRunner` in formula columns, which recalculate on their own. */
  skippedFormula: number;
  /** Rows or columns of the clipboard that fell outside the grid. */
  clipped: boolean;
}

/** Blank clears the cell. Text with the copy-time apostrophe gets it back off, so copy then paste is exact. */
const blankToNull = (text: string) => (text.trim() === "" ? null : restoreFormula(text));

/**
 * Turns clipboard cells into edits. A single value pasted over a larger selection fills the selection;
 * anything else lands with its top left corner on the selection's top left corner and stops at the edge of the loaded rows.
 */
export function planPaste(matrix: readonly (readonly string[])[], target: Bounds, rows: readonly GridRow[], columns: readonly GridColumn[]): PastePlan {
  const updates: CellEditInput[] = [];
  let skippedRunner = 0;
  let skippedFormula = 0;
  let clipped = false;
  const fill = matrix.length === 1 && matrix[0].length === 1 && (target.r1 > target.r0 || target.c1 > target.c0);

  const height = fill ? target.r1 - target.r0 + 1 : matrix.length;
  for (let r = 0; r < height; r++) {
    const row = rows[target.r0 + r];
    if (!row) {
      clipped = true;
      break;
    }
    const line = fill ? matrix[0] : matrix[r];
    const width = fill ? target.c1 - target.c0 + 1 : line.length;
    for (let c = 0; c < width; c++) {
      const column = columns[target.c0 + c];
      if (!column) {
        clipped = true;
        break;
      }
      if (!isStaticColumnType(column.type)) {
        skippedRunner += 1;
        if (column.type === "formula") skippedFormula += 1;
        continue;
      }
      updates.push({ rowId: row.id, columnKey: column.key, value: blankToNull(fill ? line[0] : (line[c] ?? "")) });
    }
  }
  return { updates, skippedRunner, skippedFormula, clipped };
}

/** What the server's paste route takes. The rows after `anchorRowId` in table order take the lines. */
export interface BlockPasteRequest {
  anchorRowId: string;
  columnKeys: string[];
  newColumns: number;
  values: Array<Array<string | null>>;
}

export type PasteRoute =
  /** The block fits the loaded rows and columns: write it with the cell edits. */
  | { kind: "cells"; plan: PastePlan }
  /** The block reaches past the loaded rows or the last column: the server finds, creates and writes. */
  | { kind: "block"; request: BlockPasteRequest }
  | { kind: "refuse"; message: string };

/** Mirrors the server's limits (`GRID_LIMITS.addRows`, `cellUpdates`, `MAX_PASTE_NEW_COLUMNS`). */
export const PASTE_LIMITS = { rows: 1_000, cells: 5_000, newColumns: 100 } as const;

export const GROWTH_NEEDS_TABLE_ORDER = "This view is filtered, sorted or searched, so a paste cannot add rows or columns. Clear the filter, sort and search, then paste again.";
export const ROWS_NOT_LOADED = "That paste reaches rows that are not loaded, and this view is filtered, sorted or searched. Scroll down to load more rows, or clear the filter, sort and search.";

const cellCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "cell" : "cells"}`;

/**
 * The clause for cells a paste or fill left alone, told apart by why: formula columns recalculate, AI and enrichment
 * columns (and their outputs) are filled by a run. `total` counts both, `formula` is the formula share. Empty when none.
 */
export function skippedCellsText(total: number, formula: number): string {
  const parts: string[] = [];
  if (formula > 0) parts.push(`${cellCount(formula)} in formula columns (they recalculate)`);
  if (total - formula > 0) parts.push(`${cellCount(total - formula)} in AI or enrichment columns (a run fills them)`);
  return parts.length === 0 ? "" : `Skipped ${parts.join(" and ")}.`;
}

/** The toast after a block paste: what was written and created, what was skipped and what the column type refused. */
export function pasteSummary(outcome: { cells: number; addedRows: number; addedColumns: number; skippedRunner: number; skippedFormula: number; invalidCount: number }): string {
  const made: string[] = [];
  if (outcome.addedRows > 0) made.push(`${outcome.addedRows.toLocaleString("en-US")} ${outcome.addedRows === 1 ? "row" : "rows"}`);
  if (outcome.addedColumns > 0) made.push(`${outcome.addedColumns.toLocaleString("en-US")} ${outcome.addedColumns === 1 ? "column" : "columns"}`);
  const sentences = [`Pasted ${cellCount(outcome.cells)}${made.length > 0 ? ` and added ${made.join(" and ")}` : ""}.`];
  const skipped = skippedCellsText(outcome.skippedRunner, outcome.skippedFormula);
  if (skipped) sentences.push(skipped);
  if (outcome.invalidCount > 0) sentences.push(`${cellCount(outcome.invalidCount)} did not fit the column type and ${outcome.invalidCount === 1 ? "was" : "were"} not saved.`);
  return sentences.join(" ");
}

export interface PasteContext {
  rows: readonly GridRow[];
  /** The columns in the order the grid shows them. */
  columns: readonly GridColumn[];
  /** Rows the view holds, loaded or not. */
  total: number;
  /** True when the loaded rows are the table in table order (no filter, sort or search). */
  keepsOrder: boolean;
}

/**
 * Decides how a pasted block is written. A block inside the loaded cells goes through the normal cell edits. One
 * that reaches past the last loaded row (rows that exist but were never loaded, or rows to create) or past the
 * last column goes to the server, which can find rows by position and create what is missing. That is only sound
 * while the grid shows the table in table order, so any other view refuses with a reason.
 */
export function routePaste(matrix: readonly (readonly string[])[], target: Bounds, ctx: PasteContext): PasteRoute {
  const height = matrix.length;
  const width = matrix.reduce((max, line) => Math.max(max, line.length), 0);
  const fill = height === 1 && width === 1 && (target.r1 > target.r0 || target.c1 > target.c0);
  const reachesRows = target.r0 + height > ctx.rows.length;
  const reachesColumns = target.c0 + width > ctx.columns.length;
  if (fill || (!reachesRows && !reachesColumns)) return { kind: "cells", plan: planPaste(matrix, target, ctx.rows, ctx.columns) };

  if (!ctx.keepsOrder) return { kind: "refuse", message: reachesRows && ctx.rows.length < ctx.total && !reachesColumns ? ROWS_NOT_LOADED : GROWTH_NEEDS_TABLE_ORDER };
  const anchor = ctx.rows[target.r0];
  if (!anchor) return { kind: "refuse", message: "Select a row to paste into." };
  if (height > PASTE_LIMITS.rows) return { kind: "refuse", message: `Paste up to ${PASTE_LIMITS.rows.toLocaleString("en-US")} rows at a time.` };
  if (height * width > PASTE_LIMITS.cells) return { kind: "refuse", message: `Paste up to ${PASTE_LIMITS.cells.toLocaleString("en-US")} cells at a time.` };
  const newColumns = Math.max(0, target.c0 + width - ctx.columns.length);
  if (newColumns > PASTE_LIMITS.newColumns) return { kind: "refuse", message: `A paste can add up to ${PASTE_LIMITS.newColumns} columns. Paste fewer columns.` };
  return {
    kind: "block",
    request: {
      anchorRowId: anchor.id,
      columnKeys: ctx.columns.slice(target.c0, target.c0 + width).map((c) => c.key),
      newColumns,
      values: matrix.map((line) => Array.from({ length: width }, (_, c) => blankToNull(line[c] ?? ""))),
    },
  };
}
