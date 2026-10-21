import { effectiveColumnType, isStaticColumnType, STATIC_COLUMN_TYPES, type ColumnType } from "@/contexts/grid/domain/column-types";
import type { CellMeta, GridColumn, GridRow } from "../data/types";

export const TYPE_LABELS: Record<string, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  boolean: "Checkbox",
  date: "Date",
  url: "URL",
  email: "Email",
  image: "Image URL",
  select: "Select",
  multiselect: "Multi select",
  json: "JSON",
  enrichment: "Enrichment",
  integration_output: "Enrichment output",
  ai_output: "AI output",
  http: "HTTP",
  ai: "AI",
  functions: "Functions",
  message: "Message",
  waterfall: "Waterfall",
  formula: "Formula",
  merge: "Merge",
};

export const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;

export const EDITABLE_TYPE_OPTIONS = STATIC_COLUMN_TYPES.map((value) => ({ value, label: typeLabel(value) }));

export const RUNNER_TYPES_WITH_RUN: ReadonlySet<string> = new Set(["enrichment", "waterfall", "ai"]);

/** Only static columns take typed values. A runner column's value comes from its run. */
export const isEditableColumn = (column: Pick<GridColumn, "type">) => isStaticColumnType(column.type);

export interface SelectOption {
  value: string;
  label: string;
}

export function selectOptions(column: Pick<GridColumn, "config">): SelectOption[] {
  const raw = column.config.options;
  if (!Array.isArray(raw)) return [];
  const out: SelectOption[] = [];
  for (const o of raw) {
    if (typeof o === "string") out.push({ value: o, label: o });
    else if (o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string") {
      const v = o as { value: string; label?: unknown };
      out.push({ value: v.value, label: typeof v.label === "string" ? v.label : v.value });
    }
  }
  return out;
}

/** Compact one-line text of any stored value. */
export function displayValue(value: unknown, column: Pick<GridColumn, "type" | "config">): string {
  if (value === null || value === undefined) return "";
  const type = effectiveColumnType(column);
  if (typeof value === "string") return (holdsVerdict(column) && VERDICT_LABELS[value]) || value;
  if (typeof value === "number") {
    if (type === "currency") {
      const currency = typeof column.config.currency === "string" ? column.config.currency : "USD";
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  return JSON.stringify(value);
}

/** Text an editor starts with. Strings stay as stored, structured values become JSON or comma lists. */
export function editorText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  return JSON.stringify(value, null, 2);
}

/** Editor text to the value sent to the server, which coerces by column type. Blank clears the cell. */
export function parseEditorText(text: string): string | null {
  return text.trim() === "" ? null : text;
}

export function cellStatus(row: GridRow, columnKey: string): { state: "idle" | "running" | "waiting" | "error" | "stale" | "miss" | "skipped"; message?: string } {
  const meta: CellMeta | undefined = row.cellMeta[columnKey];
  if (!meta) return { state: "idle" };
  // A cell queued again after a try waits for a reason (a vendor's 429, a busy provider) until a time.
  if (meta.status === "queued" && meta.runAfter) {
    const at = new Date(meta.runAfter);
    const when = Number.isNaN(at.getTime()) ? "soon" : `after ${at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
    return { state: "waiting", message: `Runs again ${when}.${meta.reason ? ` ${meta.reason}` : ""}` };
  }
  if (meta.status === "running" || meta.status === "queued" || meta.status === "waiting") return { state: "running" };
  if (meta.status === "error" || meta.status === "failed") return { state: "error", message: meta.error ?? "The run failed." };
  if (meta.status === "skipped: cap") return { state: "skipped", message: meta.reason ?? "Not run automatically: over the auto-run limit." };
  // A formula cell whose LOOKUP source changed after its last run. The value is the old one.
  if (meta.status === "stale") return { state: "stale", message: meta.error ?? "The source changed. Recalculate this column." };
  if (meta.outcome === "miss") {
    const steps = meta.unanswered?.length ? ` Steps that did not answer: ${meta.unanswered.join("; ")}.` : "";
    return { state: "miss", message: `Not settled: no provider found or confirmed this.${steps}` };
  }
  return { state: "idle" };
}

/** A cell's last result in words, for the cell drawer. */
export function cellResultText(meta: Pick<CellMeta, "status" | "outcome">): string | null {
  if (meta.status === "success") return meta.outcome === "miss" ? "Nothing found or settled" : "Found";
  if (meta.status === "error" || meta.status === "failed") return "Failed";
  if (meta.status === "queued" || meta.status === "waiting") return "Waiting to run";
  if (meta.status === "running") return "Running";
  if (meta.status === "skipped: cap") return "Held back by the auto-run limit";
  if (meta.status === "stale") return "Out of date";
  return meta.status ?? null;
}

/** One ledger row's outcome in words. */
export const RUN_OUTCOME_LABELS: Readonly<Record<string, string>> = { hit: "Found", miss: "Missed", error: "Error", failed: "Failed", skipped: "Skipped", cancelled: "Cancelled" };

/** Words for the verification verdicts every verifier maps onto. The stored value stays the code, for filters and exports. */
export const VERDICT_LABELS: Readonly<Record<string, string>> = { valid: "Valid", invalid: "Invalid", catch_all: "Catch-all", unknown: "Unknown", disposable: "Disposable" };

/** True for a cell that holds a verdict: a verify-email column's own cell, or its Status and Verification status outputs. */
function holdsVerdict(column: Pick<GridColumn, "type" | "config">): boolean {
  const config = column.config as { outputKey?: unknown; actionKey?: unknown; steps?: Array<{ actionKey?: unknown }> };
  if (column.type === "integration_output") return config.outputKey === "status" || config.outputKey === "verificationStatus";
  if (column.type === "enrichment") return config.actionKey === "verify-email";
  if (column.type === "waterfall") return config.steps?.[0]?.actionKey === "verify-email";
  return false;
}

export const DEFAULT_WIDTH: Record<string, number> = {
  boolean: 90,
  number: 120,
  currency: 130,
  date: 130,
  select: 150,
  multiselect: 200,
  json: 220,
  formula: 180,
  ai: 220,
  ai_output: 200,
  integration_output: 180,
  enrichment: 200,
  waterfall: 200,
};

export const columnWidth = (column: Pick<GridColumn, "type">) => DEFAULT_WIDTH[column.type] ?? 180;

/** Column key for a freshly typed name, only for display hints. The server derives the real key. */
export const isRunnerType = (type: ColumnType | string) => !isStaticColumnType(type) && type !== "formula";

/** "Reused, no charge", "$0.03 · 1 credit", "1 credit" or "No charge": a billed call is never called free. */
export function runCost(r: { costCents: number; credits: number | null; reused?: boolean }): string {
  if (r.reused) return "Reused, no charge";
  const parts = [r.costCents > 0 ? `$${(r.costCents / 100).toFixed(2)}` : null, r.credits !== null && r.credits > 0 ? `${Number(r.credits.toFixed(2))} ${r.credits === 1 ? "credit" : "credits"}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No charge";
}
