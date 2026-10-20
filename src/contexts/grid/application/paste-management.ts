import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { coerceCellInput } from "../domain/cell-values";
import { effectiveColumnType, isStaticColumnType } from "../domain/column-types";
import { activeConditionCount } from "../domain/view-query";
import { notifyCellsChanged, type CellChange } from "./cell-events";
import { GRID_LIMITS } from "./limits";
import { refreshAfterSourceWrite } from "./formula-lookup-refresh";
import { recalculateFormulasQuietly } from "./formula-recalc";
import { resolveView } from "./structure-management";
import type { GridDeps, PasteWrite, RowRecord } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

/** Most new columns one paste may create. */
export const MAX_PASTE_NEW_COLUMNS = 100;

export interface PasteInput {
  /** The row at the top left of the block. Rows after it in table order take the next lines. */
  anchorRowId: string;
  /** Columns the block starts on, left to right. Hidden or pinned display order does not matter, the client resolves it. */
  columnKeys: string[];
  /** Text columns to create after the last of `columnKeys`. */
  newColumns: number;
  /** A rectangle of text: `values[row][column]`, one entry per `columnKeys` plus `newColumns`. Null is an empty cell. */
  values: Array<Array<string | null>>;
  /** The grid's transient search. A paste only grows a table that is shown whole and in table order. */
  search?: string;
}

export const PASTE_NEEDS_TABLE_ORDER = "This view is filtered, sorted or searched, so a paste cannot add rows or columns, and rows beyond the loaded ones cannot be found. Clear the filter, sort and search, then paste again.";

function parse(input: unknown): PasteInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ValidationError("Send the paste as an object");
  const body = input as Record<string, unknown>;
  const { anchorRowId, columnKeys, values } = body;
  if (typeof anchorRowId !== "string" || !anchorRowId) throw new ValidationError("anchorRowId is required");
  if (!Array.isArray(columnKeys) || columnKeys.length === 0 || columnKeys.length > GRID_LIMITS.columnsPerTable || columnKeys.some((k) => typeof k !== "string" || !k)) {
    throw new ValidationError(`columnKeys must hold between 1 and ${GRID_LIMITS.columnsPerTable} column keys`);
  }
  if (new Set(columnKeys).size !== columnKeys.length) throw new ValidationError("columnKeys cannot repeat a column");
  const newColumns = body.newColumns === undefined ? 0 : body.newColumns;
  if (typeof newColumns !== "number" || !Number.isInteger(newColumns) || newColumns < 0 || newColumns > MAX_PASTE_NEW_COLUMNS) {
    throw new ValidationError(`newColumns must be a whole number from 0 to ${MAX_PASTE_NEW_COLUMNS}`);
  }
  if (!Array.isArray(values) || values.length === 0) throw new ValidationError("values must be a list of rows");
  if (values.length > GRID_LIMITS.addRows) throw new ValidationError(`A paste holds at most ${GRID_LIMITS.addRows.toLocaleString("en-US")} rows`);
  const width = columnKeys.length + newColumns;
  if (values.length * width > GRID_LIMITS.cellUpdates) throw new ValidationError(`A paste holds at most ${GRID_LIMITS.cellUpdates.toLocaleString("en-US")} cells`);
  for (const line of values) {
    if (!Array.isArray(line) || line.length !== width) throw new ValidationError("Every pasted row needs one value per column");
    if (line.some((v) => v !== null && typeof v !== "string")) throw new ValidationError("Pasted values must be text or null");
  }
  const search = body.search;
  if (search !== undefined && typeof search !== "string") throw new ValidationError("search must be text");
  return { anchorRowId, columnKeys: columnKeys as string[], newColumns, values: values as Array<Array<string | null>>, search };
}

/**
 * Pastes a block anchored at a row, in one transaction. It finds the rows after the anchor in table order (so rows the
 * client has not loaded count), creates the rows and text columns the block needs, and writes the cells. Cells in
 * columns that a run fills are skipped, and a value the column type refuses is skipped and reported, so one bad cell
 * does not lose the block. It writes nothing past 1,000 rows or 5,000 cells, and nothing when anything fails.
 * Rows and columns are added only while the member's view shows the whole table in table order.
 */
export async function pasteCells(deps: Deps, actor: Actor, tableId: string, raw: unknown) {
  const input = parse(raw);
  const org = actor.organizationId;
  const [table, columns] = await Promise.all([deps.structure.getTable(org, tableId), deps.columns.list(org, tableId)]);
  if (!table) throw new NotFoundError("Table not found");

  const view = (await resolveView(deps, actor, table, columns)).view;
  const types = new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const));
  if (input.search?.trim() || activeConditionCount(view.filters, types) > 0 || (view.sorts?.length ?? 0) > 0) throw new ValidationError(PASTE_NEEDS_TABLE_ORDER);

  const height = input.values.length;
  let skippedRunner = 0;
  let skippedFormula = 0;
  const invalid: Array<{ rowIndex: number; columnKey: string; error: string }> = [];
  const written: PasteWrite["cells"] = [];

  const result = await deps.rows.paste(
    org,
    tableId,
    { anchorRowId: input.anchorRowId, height, columnKeys: input.columnKeys, newColumns: input.newColumns, limits: { maxRows: GRID_LIMITS.tableRows, maxColumns: GRID_LIMITS.columnsPerTable, maxNewRows: GRID_LIMITS.addRows } },
    (current) => {
      const keys = [...input.columnKeys, ...current.created.map((c) => c.key)];
      const byKey = new Map(current.columns.map((c) => [c.key, c]));
      keys.forEach((key, c) => {
        const column = byKey.get(key);
        if (!column) return;
        const type = column.type;
        if (!isStaticColumnType(type)) {
          skippedRunner += height;
          if (type === "formula") skippedFormula += height;
          return;
        }
        input.values.forEach((line, r) => {
          const coerced = coerceCellInput(line[c], type);
          if (coerced.ok) written.push({ rowIndex: r, columnKey: key, value: coerced.value ?? null });
          else invalid.push({ rowIndex: r, columnKey: key, error: coerced.error });
        });
      });
      return { cells: written };
    },
  );
  if (!result) throw new NotFoundError("Table not found");

  const applied: Array<{ rowId: string; columnKey: string; before: unknown; value: unknown }> = [];
  const changed: CellChange[] = [];
  for (const cell of written) {
    const rowId = result.rowIds[cell.rowIndex];
    const before = result.previous.get(rowId)?.[cell.columnKey] ?? null;
    const value = cell.value ?? null;
    applied.push({ rowId, columnKey: cell.columnKey, before, value });
    if (JSON.stringify(before) !== JSON.stringify(value)) changed.push({ rowId, columnKey: cell.columnKey, previous: before, value });
  }

  const { queued, skippedByCap } = await notifyCellsChanged({ organizationId: org, tableId, userId: actor.userId, changes: changed });
  const rowIds = result.rows.map((r) => r.id);
  const recalculated = await recalculateFormulasQuietly(deps, org, tableId, { rowIds, changedKeys: changed.map((c) => c.columnKey) });
  const lookups = changed.length > 0 ? await refreshAfterSourceWrite(deps, org, table, [...new Set(changed.map((c) => c.columnKey))]) : null;
  const rows = recalculated > 0 || (lookups && lookups.recalculated + lookups.stale > 0) ? ((await deps.rows.listByIds(org, tableId, rowIds)) as RowRecord[]) : result.rows;

  return {
    rows,
    applied,
    addedRows: result.addedRows,
    createdColumns: result.createdColumns,
    skippedRunner,
    skippedFormula,
    invalid: invalid.slice(0, 20),
    invalidCount: invalid.length,
    queued,
    skippedByCap,
  };
}
