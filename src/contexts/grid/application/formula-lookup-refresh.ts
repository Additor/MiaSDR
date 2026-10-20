import { columnTokens, readsLookupSource, tableTokens, type LookupSourceChange } from "../domain/formula-dependencies";
import { compileFormula } from "../domain/formula";
import { recalculateFormulasQuietly } from "./formula-recalc";
import type { ColumnRecord, GridDeps, TableRecord } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

/**
 * Bounds one source change. A source edit can reach formula columns in many tables, and each one is a scan of
 * its whole table, so a trigger recalculates at most `columns` formula columns and `rows` table rows (counted
 * once per dependent table). A column past either bound keeps its value and gets a visible "stale" marker
 * until someone runs Recalculate on it. `depth` bounds chains of formulas that look up formulas.
 */
export const LOOKUP_REFRESH_LIMITS = { columns: 10, rows: 10_000, depth: 3 } as const;

export interface LookupRefreshResult {
  /** Formula columns recalculated. */
  recalculated: number;
  /** Formula columns marked stale instead. */
  stale: number;
}

interface Budget {
  columns: number;
  rows: number;
}

/**
 * Formula columns of the workbook that read the changed LOOKUP source, found through the tables and columns
 * named in their expressions. Auto-run formulas within the limits are recalculated. The others are marked stale,
 * and so are all of them with `markOnly`, which a background writer uses (one trigger per finished cell would
 * rescan the dependent tables each time).
 * `sourceLabel` names the source in the stale reason.
 */
export async function refreshLookupDependents(
  deps: Deps,
  organizationId: string,
  workbookId: string,
  change: LookupSourceChange,
  sourceLabel: string,
  options: { budget?: Budget; depth?: number; markOnly?: boolean } = {},
): Promise<LookupRefreshResult> {
  const result: LookupRefreshResult = { recalculated: 0, stale: 0 };
  const budget = options.budget ?? { columns: LOOKUP_REFRESH_LIMITS.columns, rows: LOOKUP_REFRESH_LIMITS.rows };
  const depth = options.depth ?? 0;
  if (depth >= LOOKUP_REFRESH_LIMITS.depth) return result;

  const formulas = await deps.formulas.formulaColumns(organizationId, workbookId);
  const dependents = formulas.filter((column) => {
    const expression = typeof column.config.expression === "string" ? column.config.expression : "";
    const compiled = compileFormula(expression);
    return compiled.ok && compiled.formula.references.lookups.length > 0 && readsLookupSource(compiled.formula.references.lookups, change);
  });

  const byTable = new Map<string, ColumnRecord[]>();
  for (const column of dependents) byTable.set(column.tableId, [...(byTable.get(column.tableId) ?? []), column]);

  for (const [tableId, columns] of byTable) {
    const table = await deps.structure.getTable(organizationId, tableId);
    if (!table) continue;
    const rowCount = await deps.rows.count(organizationId, tableId);
    const run: ColumnRecord[] = [];
    const stale: ColumnRecord[] = [];
    for (const column of columns) {
      // A column with auto-run off waits for an explicit Recalculate, like it does for edits of the columns it reads.
      if (!options.markOnly && column.autoRun && budget.columns > 0 && budget.rows >= rowCount) {
        budget.columns -= 1;
        run.push(column);
      } else {
        stale.push(column);
      }
    }
    if (run.length > 0) {
      budget.rows -= rowCount;
      await recalculateFormulasQuietly(deps, organizationId, tableId, { columnKeys: run.map((c) => c.key) });
      result.recalculated += run.length;
      // Formulas elsewhere may look these columns up in turn.
      const next = await refreshLookupDependents(deps, organizationId, workbookId, { tableTokens: tableTokens(table), columnTokens: run.flatMap(columnTokens) }, `"${table.name}"`, { budget, depth: depth + 1 });
      result.recalculated += next.recalculated;
      result.stale += next.stale;
    }
    if (stale.length > 0) {
      await deps.rows.markStale(organizationId, tableId, stale.map((c) => c.key), `The lookup source ${sourceLabel} changed. Choose Recalculate on this column.`);
      result.stale += stale.length;
    }
  }
  return result;
}

/** Same as `refreshLookupDependents`, but a failure is logged and never fails the edit that is already saved. */
export async function refreshLookupDependentsQuietly(...args: Parameters<typeof refreshLookupDependents>): Promise<LookupRefreshResult> {
  try {
    return await refreshLookupDependents(...args);
  } catch (error) {
    console.error("[grid] lookup refresh failed:", error instanceof Error ? error.message : error);
    return { recalculated: 0, stale: 0 };
  }
}

/**
 * Cell, row or import changes in a table: the formulas that look up one of the changed columns (or any column
 * when `columnKeys` is omitted) are refreshed. Loads the table's columns to turn keys into names.
 */
export async function refreshAfterSourceWrite(
  deps: Deps,
  organizationId: string,
  table: Pick<TableRecord, "id" | "name" | "workbookId">,
  columnKeys?: readonly string[],
  options: { markOnly?: boolean } = {},
): Promise<LookupRefreshResult> {
  const columns = columnKeys ? (await deps.columns.list(organizationId, table.id)).filter((c) => columnKeys.includes(c.key)) : null;
  if (columns && columns.length === 0) return { recalculated: 0, stale: 0 };
  return refreshLookupDependentsQuietly(deps, organizationId, table.workbookId, { tableTokens: tableTokens(table), columnTokens: columns ? columns.flatMap(columnTokens) : null }, `"${table.name}"`, options);
}
