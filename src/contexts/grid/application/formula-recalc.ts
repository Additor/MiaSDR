import { ConflictError } from "@/shared/errors";
import { compileFormula, evaluateFormula, FORMULA_ERROR_TEXT, type CompiledFormula, type FormulaErrorCode, type FormulaLookupRegistry } from "../domain/formula";
import { textColumnKeys } from "./formula-management";
import type { CellEdit, ColumnRecord, GridDeps, RowRecord } from "./ports";

type Deps = Pick<GridDeps, "columns" | "rows" | "formulas">;

/**
 * A formula cell whose expression cannot run on that row shows `#ERROR` (a divide by zero, text where a number
 * belongs), `#REF` (a LOOKUP names a table or column that is gone) or `#LOOKUP` (the source cannot be read).
 * The reason is kept in the cell's metadata as `{ status: "error", code, error }`; see `FORMULA_ERROR_TEXT`.
 */
const BATCH = 500;
const MARK_CHUNK = 1000;

/**
 * Longest a recalculation may run inside one request. It is checked between batches, so one batch can run past it.
 * A table of 50,000 rows took 2.9 s on Postgres 17 in Docker; the budget stops a slow
 * database or an unexpected volume from holding the request open, and the stop is visible (see `markUnfinished`).
 */
export const RECALC_BUDGET_MS = 25_000;

/** The recalculation ran out of time. The rows it finished are saved; the column is marked stale for the rest. */
export class RecalcBudgetError extends ConflictError {
  constructor(
    readonly changedCells: number,
    readonly budgetMs: number,
    /** Rows the run did not reach. They are the ones marked stale. */
    readonly remainingRowIds: readonly string[] = [],
  ) {
    super(`Recalculation stopped after ${Math.round(budgetMs / 1000)} seconds. ${changedCells.toLocaleString("en-US")} ${changedCells === 1 ? "cell is" : "cells are"} updated. Choose Recalculate on the column again to finish.`, { changedCells });
    this.name = "RecalcBudgetError";
  }
}

interface Planned {
  column: ColumnRecord;
  /** Null when the stored expression no longer compiles; every cell then holds `failure`. */
  formula: CompiledFormula | null;
  failure?: string;
  lookups: FormulaLookupRegistry;
}

/** The cell metadata a failed formula leaves behind, so the grid can say why. */
export const errorMeta = (code: FormulaErrorCode, reason: string): Record<string, unknown> => ({ status: "error", code, error: reason });

/** Formula columns in an order where every formula comes after the formula columns it reads. */
function inDependencyOrder(formulas: ColumnRecord[]): ColumnRecord[] {
  const keys = new Set(formulas.map((c) => c.key));
  const ordered: ColumnRecord[] = [];
  const placed = new Set<string>();
  let rest = formulas;
  while (rest.length > 0) {
    const ready = rest.filter((c) => c.dependsOn.every((d) => !keys.has(d) || d === c.key || placed.has(d)));
    // A cycle cannot be saved. If one slipped in, keep going in stored order instead of looping forever.
    const next = ready.length > 0 ? ready : rest;
    for (const c of next) {
      ordered.push(c);
      placed.add(c.key);
    }
    rest = rest.filter((c) => !placed.has(c.key));
  }
  return ordered;
}

/** True for a formula column that calls TODAY or NOW. The cheap text test comes first so a plain formula is never parsed here. */
export function isVolatileColumn(column: ColumnRecord): boolean {
  if (column.type !== "formula" || typeof column.config.expression !== "string" || !/\b(today|now)\s*\(/i.test(column.config.expression)) return false;
  const compiled = compileFormula(column.config.expression);
  return compiled.ok && compiled.formula.references.volatile;
}

/**
 * Formula columns to recompute: `columnKeys` themselves, plus every auto-run formula that reads a key
 * in `changedKeys`, plus the formulas that read those. Columns with auto-run off wait for a new save.
 * A volatile formula (TODAY, NOW) depends on the clock, not on a key: it joins whenever rows were edited
 * (`changedKeys` is not empty), which the caller limits to the edited rows, and when it is named in `columnKeys`
 * (the Recalculate action). A lookup refresh or any other run that names other columns leaves it alone.
 */
export function formulasToRecalculate(columns: readonly ColumnRecord[], scope: { changedKeys?: readonly string[]; columnKeys?: readonly string[] }): ColumnRecord[] {
  const formulas = columns.filter((c) => c.type === "formula");
  const picked = new Set<string>(scope.columnKeys ?? []);
  const dirty = new Set<string>([...(scope.changedKeys ?? []), ...picked]);
  if ((scope.changedKeys?.length ?? 0) > 0) {
    for (const c of formulas) {
      if (c.autoRun && isVolatileColumn(c)) {
        picked.add(c.key);
        dirty.add(c.key);
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of formulas) {
      if (picked.has(c.key) || !c.autoRun) continue;
      if (c.dependsOn.some((d) => dirty.has(d))) {
        picked.add(c.key);
        dirty.add(c.key);
        grew = true;
      }
    }
  }
  return inDependencyOrder(formulas.filter((c) => picked.has(c.key)));
}

interface EvalContext {
  textKeys: Set<string>;
  now: Date;
  timeZone?: string;
}

function editsFor(rows: readonly RowRecord[], planned: readonly Planned[], context: EvalContext): CellEdit[] {
  const { textKeys, now, timeZone } = context;
  const out: CellEdit[] = [];
  for (const row of rows) {
    const cells: Record<string, unknown> = { ...row.cells };
    const set: Record<string, unknown> = {};
    const meta: Record<string, Record<string, unknown> | null> = {};
    for (const { column, formula, failure, lookups } of planned) {
      const result = formula ? evaluateFormula(formula, cells, { textKeys, lookups, now, timeZone }) : { ok: false as const, error: failure ?? "The formula could not be read", code: "ERROR" as const };
      const raw = result.ok ? result.value : FORMULA_ERROR_TEXT[result.code];
      const value = Array.isArray(raw) ? raw.join(", ") : raw;
      cells[column.key] = value;
      if (JSON.stringify(row.cells[column.key] ?? null) !== JSON.stringify(value ?? null)) set[column.key] = value;
      // A result clears an error or stale marker left by an earlier run. An error replaces it with the new reason.
      const before = row.cellMeta[column.key];
      if (result.ok) {
        if (before !== undefined) meta[column.key] = null;
      } else {
        const next = errorMeta(result.code, result.error);
        if (JSON.stringify(before ?? null) !== JSON.stringify(next)) meta[column.key] = next;
      }
    }
    if (Object.keys(set).length > 0 || Object.keys(meta).length > 0) out.push(Object.keys(meta).length > 0 ? { rowId: row.id, set, meta } : { rowId: row.id, set });
  }
  return out;
}

/**
 * Computes formula columns and stores the results in the rows. A formula is a pure function of its row,
 * so it runs here and not through the cell queue. `rowIds` limits the rows; without it every row is read.
 * Returns how many cells changed. LOOKUP formulas read other tables: `refreshLookupDependents` recalculates
 * them when a source changes, and the Recalculate action runs this for one column.
 * `options.now` is the clock for TODAY and NOW; one instant serves the whole run. The organization time zone is
 * read once, and only when a planned formula uses a date function.
 */
export async function recalculateFormulas(
  deps: Deps,
  organizationId: string,
  tableId: string,
  scope: { rowIds?: readonly string[]; changedKeys?: readonly string[]; columnKeys?: readonly string[] },
  options: { now?: () => Date; budgetMs?: number; clock?: () => number } = {},
): Promise<number> {
  const columns = await deps.columns.list(organizationId, tableId);
  const targets = formulasToRecalculate(columns, scope);
  if (targets.length === 0) return 0;

  const planned: Planned[] = [];
  let timeZone: string | undefined;
  for (const column of targets) {
    const expression = typeof column.config.expression === "string" ? column.config.expression : "";
    const compiled = compileFormula(expression);
    if (!compiled.ok) {
      planned.push({ column, formula: null, failure: compiled.error, lookups: {} });
      continue;
    }
    if (compiled.formula.references.usesDates && timeZone === undefined) timeZone = await deps.formulas.organizationTimeZone(organizationId);
    const calls = compiled.formula.references.lookups;
    // Resolution problems come back as failures inside the registry, so they reach the cell as #REF or #LOOKUP.
    const lookups = calls.length > 0 ? await deps.formulas.lookupRegistry(organizationId, tableId, calls) : {};
    planned.push({ column, formula: compiled.formula, lookups });
  }
  if (planned.length === 0) return 0;
  const context: EvalContext = { textKeys: textColumnKeys(columns), now: (options.now ?? (() => new Date()))(), timeZone };

  let changed = 0;
  const clock = options.clock ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? RECALC_BUDGET_MS;
  const started = clock();
  const write = async (rows: readonly RowRecord[]) => {
    const batch = editsFor(rows, planned, context);
    if (batch.length === 0) return;
    await deps.rows.applyEdits(organizationId, tableId, batch);
    changed += batch.reduce((n, e) => n + new Set([...Object.keys(e.set), ...Object.keys(e.meta ?? {})]).size, 0);
  };

  // Once the budget is spent the run stops writing but keeps reading ids, so it can say which rows it did not reach.
  const remaining: string[] = [];
  let over = false;
  const step = async (rows: readonly RowRecord[]) => {
    if (!over && clock() - started > budgetMs) over = true;
    if (over) remaining.push(...rows.map((r) => r.id));
    else await write(rows);
  };
  if (scope.rowIds) {
    const ids = [...new Set(scope.rowIds)];
    for (let i = 0; i < ids.length; i += BATCH) await step(await deps.rows.listByIds(organizationId, tableId, ids.slice(i, i + BATCH)));
  } else {
    for await (const rows of deps.rows.scan(organizationId, tableId, { batch: BATCH })) await step(rows);
  }
  if (over) throw new RecalcBudgetError(changed, budgetMs, remaining);
  return changed;
}

/**
 * Leaves a visible trace when a recalculation did not finish: every cell of the formula columns it was to compute
 * (or only the edited rows) gets a stale marker whose message says why. A later successful run clears the marker.
 * Best effort: a failure here is logged and never replaces the original error.
 */
async function markUnfinished(deps: Deps, organizationId: string, tableId: string, scope: Parameters<typeof recalculateFormulas>[3], error: unknown): Promise<void> {
  try {
    const keys = formulasToRecalculate(await deps.columns.list(organizationId, tableId), scope).map((c) => c.key);
    if (keys.length === 0) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    // A budget stop already says what to do next.
    const reason = error instanceof RecalcBudgetError ? message : `Recalculation did not finish: ${message} Choose Recalculate on this column.`;
    // A budget stop knows which rows it did not reach; any other failure may have saved any of them, so all count.
    const only = error instanceof RecalcBudgetError ? error.remainingRowIds : scope.rowIds ? [...new Set(scope.rowIds)] : undefined;
    if (only === undefined) await deps.rows.markStale(organizationId, tableId, keys, reason);
    else for (let i = 0; i < only.length; i += MARK_CHUNK) await deps.rows.markStale(organizationId, tableId, keys, reason, only.slice(i, i + MARK_CHUNK));
  } catch (failure) {
    console.error("[grid] could not mark the unfinished formula cells:", failure instanceof Error ? failure.message : failure);
  }
}

/** Recalculates one formula column over every row, plus the formulas that read it. Failures throw, after the column is marked stale. */
export async function recalculateFormula(deps: Deps, organizationId: string, tableId: string, columnKey: string): Promise<number> {
  const scope = { columnKeys: [columnKey] };
  try {
    return await recalculateFormulas(deps, organizationId, tableId, scope);
  } catch (error) {
    await markUnfinished(deps, organizationId, tableId, scope, error);
    throw error;
  }
}

/**
 * Same as `recalculateFormulas`, but a failure never fails the edit or import that is already saved. It is not silent:
 * the failure is logged and the formula cells are marked stale with the reason, so the grid shows them and Recalculate fixes them.
 */
export async function recalculateFormulasQuietly(...args: Parameters<typeof recalculateFormulas>): Promise<number> {
  try {
    return await recalculateFormulas(...args);
  } catch (error) {
    console.error("[grid] formula recalculation failed:", error instanceof Error ? error.message : error);
    await markUnfinished(args[0], args[1], args[2], args[3], error);
    return 0;
  }
}
