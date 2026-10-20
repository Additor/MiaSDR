import { RUNNER_TYPES_WITH_RUN } from "../view/format";

/** The row count the run dialog and the column menu start from for "first N rows". */
export const DEFAULT_FIRST_N = 10;
export const RUN_MAX_ROWS = 10_000;
const DEFAULT_MAX_ROWS = 1000;

interface ColumnLike {
  key: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * The runner column behind a cell, or null when the cell has no run of its own. A runner column maps to itself;
 * an output column (ai_output, integration_output) maps to the column its config names, when that column runs.
 */
export function runCellSource<C extends ColumnLike>(column: ColumnLike, columns: readonly C[]): C | null {
  const key = RUNNER_TYPES_WITH_RUN.has(column.type)
    ? column.key
    : (column.type === "ai_output" || column.type === "integration_output") && typeof column.config.sourceColumnKey === "string"
      ? column.config.sourceColumnKey
      : null;
  const source = key === null ? undefined : columns.find((c) => c.key === key);
  return source && RUNNER_TYPES_WITH_RUN.has(source.type) ? source : null;
}

/** The run request for one cell. `onlyEmpty` is off so the person's explicit press replaces a filled cell. */
export const cellRunBody = (sourceKey: string, rowId: string) => ({ columnKey: sourceKey, rowIds: [rowId], onlyEmpty: false, maxRows: 1 });

/** A whole number in [min, max] read from text, or null. */
export function wholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : null;
}

export type RunScope = "all" | "selected" | "first";

export interface RunForm {
  columnKey?: string;
  scope: RunScope;
  selectedRowIds: readonly string[];
  onlyEmpty: boolean;
  /** Text of the row limit input. */
  maxRows: string;
  /** Text of the first-N input. */
  firstN: string;
  /** Text of the cost cap input. */
  maxCost: string;
}

/** Builds the request body for POST /run, or a message for the first field that cannot be sent. */
export function buildRunBody(form: RunForm): { body: Record<string, unknown> } | { error: string } {
  const maxRows = form.maxRows.trim() === "" ? DEFAULT_MAX_ROWS : wholeNumber(form.maxRows, 1, RUN_MAX_ROWS);
  if (maxRows === null) return { error: `Row limit must be a whole number from 1 to ${RUN_MAX_ROWS.toLocaleString("en-US")}.` };
  const body: Record<string, unknown> = { ...(form.columnKey ? { columnKey: form.columnKey } : {}), onlyEmpty: form.onlyEmpty, maxRows };
  if (form.scope === "selected") body.rowIds = [...form.selectedRowIds];
  if (form.scope === "first") {
    const n = wholeNumber(form.firstN, 1, RUN_MAX_ROWS);
    if (n === null) return { error: `Enter a whole number of rows from 1 to ${RUN_MAX_ROWS.toLocaleString("en-US")}.` };
    if (n > maxRows) return { error: `First ${n.toLocaleString("en-US")} rows is more than the row limit of ${maxRows.toLocaleString("en-US")}. Lower the number or raise the row limit.` };
    body.firstN = n;
  }
  if (form.maxCost.trim() !== "") {
    const cents = Number(form.maxCost);
    if (!Number.isFinite(cents) || cents < 0) return { error: "Cost cap must be zero or more." };
    body.maxCostCents = cents;
  }
  return { body };
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Toast text for a finished request. */
export function runSummary(report: { queued: number; rows: number; worstCaseCostCents: number }, dollars: (cents: number) => string): string {
  if (report.queued === 0) return "Nothing to run. Inputs are empty or the cells are already filled.";
  return `Queued ${count(report.queued, "cell", "cells")} across ${count(report.rows, "row", "rows")}. Worst case cost ${dollars(report.worstCaseCostCents)}.`;
}

/** Toast text after Retry failed. Nothing failed is not an error, so it says so. */
export function retrySummary(retried: number): string {
  return retried === 0 ? "No failed cells to retry." : `Retrying ${count(retried, "failed cell", "failed cells")}.`;
}

/** Toast text after a stop: how many waiting cells were dropped. Cells already running finish. */
export function stopSummary(cancelled: number): string {
  return `Stopped the run. ${count(cancelled, "queued cell was", "queued cells were")} removed.`;
}

/** Toast text after Recalculate on a formula column. */
export function recalcSummary(columnName: string, changed: number): string {
  return `Recalculated "${columnName}". ${count(changed, "cell", "cells")} changed.`;
}
