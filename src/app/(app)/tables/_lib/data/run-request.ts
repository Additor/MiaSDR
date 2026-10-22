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

/**
 * The run request for one cell. `onlyEmpty` is off so the person's explicit press replaces a filled cell, and `fresh`
 * asks the providers again instead of reusing an earlier answer.
 */
export const cellRunBody = (sourceKey: string, rowId: string) => ({ columnKey: sourceKey, rowIds: [rowId], onlyEmpty: false, maxRows: 1, fresh: true });

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
  /** Text of the cost cap input, in dollars. */
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
    const cents = dollarsToCents(form.maxCost);
    if (cents === null) return { error: "Cost cap must be zero or more dollars." };
    body.maxCostCents = cents;
  }
  return { body };
}

/** Cents from a dollar amount someone typed ("0.50", "$2", "1.255"), or null when it is not zero or more. */
export function dollarsToCents(text: string): number | null {
  const value = Number(text.trim().replace(/^\$/, ""));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0) return null;
  // Prices can be fractions of a cent, so keep three decimals of a cent and drop float noise.
  return Math.round(value * 100 * 1000) / 1000;
}

/** A cents amount as a dollar field shows it: 50 as "0.5", 125 as "1.25". */
export const centsToDollarsText = (cents: number) => String(Number((cents / 100).toFixed(5)));

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The worst case of a run, from POST /run, real or dry. */
export interface RunEstimate {
  cells: number;
  /** Cells an AI column answers, on the organization's AI key. Absent on an older server. */
  aiCells?: number;
  /** Names of the columns the run covers. */
  columnNames?: string[];
  rows: number;
  worstCaseCostCents: number;
  worstCaseCredits: number;
  providers: Array<{ key: string; name: string; calls: number; credits: number; cents: number }>;
  dependents: string[];
  problem?: string;
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const credits = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;

/**
 * "4 rows · up to 8 calls · 4 AI calls · up to 6 credits · up to $0.08". Credits lead, because vendors bill in credits;
 * $ shows once a provider has a price. AI calls run on the organization's AI key, so they have no price here.
 */
export function estimateHeadline(e: RunEstimate): string {
  const calls = e.providers.reduce((sum, p) => sum + p.calls, 0);
  const parts = [count(e.rows, "row", "rows")];
  if (calls > 0) parts.push(`up to ${count(calls, "call", "calls")}`);
  if ((e.aiCells ?? 0) > 0) parts.push(count(e.aiCells!, "AI call", "AI calls"));
  if (e.worstCaseCredits > 0) parts.push(`up to ${credits(e.worstCaseCredits)}`);
  if (e.worstCaseCostCents > 0) parts.push(`up to ${dollars(e.worstCaseCostCents)}`);
  return parts.join(" · ");
}

/** "Hunter 4 calls, 2 credits · ZeroBounce 4 calls, 4 credits". */
export function estimateByProvider(e: RunEstimate): string {
  return e.providers.map((p) => `${p.name} ${count(p.calls, "call", "calls")}${p.credits > 0 ? `, ${credits(p.credits)}` : ""}${p.cents > 0 ? `, ${dollars(p.cents)}` : ""}`).join(" · ");
}

/** True when a cents cap cannot stop this run: it uses credits, and no provider has a price. */
export const centsCapIsInert = (e: RunEstimate) => e.worstCaseCostCents === 0 && e.worstCaseCredits > 0;

/** Toast text for a finished request. */
export function runSummary(report: RunEstimate & { queued: number }): string {
  if (report.queued === 0) return "Nothing to run. Inputs are empty or the cells are already filled.";
  const spend = [report.worstCaseCredits > 0 ? credits(report.worstCaseCredits) : null, report.worstCaseCostCents > 0 ? dollars(report.worstCaseCostCents) : null].filter(Boolean).join(" and ");
  return `Queued ${count(report.queued, "cell", "cells")} across ${count(report.rows, "row", "rows")}.${spend ? ` Up to ${spend}.` : ""}`;
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
