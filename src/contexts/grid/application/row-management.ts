import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { parseChangeCursor } from "../domain/change-cursor";
import { coerceCellInput } from "../domain/cell-values";
import { effectiveColumnType, isStaticColumnType } from "../domain/column-types";
import { MAX_SEARCH_CHARS, type GridQuery, type TableView } from "../domain/view-query";
import { notifyCellsChanged, type CellChange } from "./cell-events";
import { GRID_LIMITS } from "./limits";
import { refreshAfterSourceWrite } from "./formula-lookup-refresh";
import { recalculateFormulasQuietly } from "./formula-recalc";
import { resolveView } from "./structure-management";
import type { CellEdit, ColumnRecord, GridDeps, RowRecord, SkippedCell } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

async function loadTable(deps: Deps, actor: Actor, tableId: string) {
  const [table, columns] = await Promise.all([deps.structure.getTable(actor.organizationId, tableId), deps.columns.list(actor.organizationId, tableId)]);
  if (!table) throw new NotFoundError("Table not found");
  return { table, columns };
}

export const refsOf = (columns: ReadonlyArray<ColumnRecord>) => columns.map((c) => ({ key: c.key, type: effectiveColumnType(c) }));

export function queryOf(view: TableView, search?: string): GridQuery {
  const term = search?.trim().slice(0, MAX_SEARCH_CHARS);
  return { filters: view.filters, sorts: view.sorts, search: term || undefined };
}

export interface TablePageInput {
  limit?: number;
  offset?: number;
  /** Transient search across every column. Not saved. */
  search?: string;
  /**
   * Fill rate per column is a full scan, so it is computed for the first page only (a reload), and only when this is
   * not false. Paging with `offset` and the search box ask without it. Skipped, `coverage` is `{}`.
   */
  coverage?: boolean;
}

/**
 * The table, its columns and one page of rows with the saved view (filters and sorts) applied.
 * `total` is the filtered count and `unfilteredTotal` the whole table.
 */
export async function getTablePage(deps: Deps, actor: Actor, tableId: string, input: TablePageInput = {}) {
  const org = actor.organizationId;
  const { table, columns } = await loadTable(deps, actor, tableId);
  const limit = Math.min(Math.max(1, input.limit ?? GRID_LIMITS.defaultPageSize), GRID_LIMITS.pageSize);
  const offset = Math.max(0, input.offset ?? 0);
  const refs = refsOf(columns);
  const resolved = await resolveView(deps, actor, table, columns);
  const query = queryOf(resolved.view, input.search);
  // The cursor comes first: rows written after it is read are in the feed, and the ones the list read too arrive twice.
  const cursor = await deps.rows.currentCursor(org, tableId);
  const [rows, total, unfilteredTotal, coverage, activeJobs] = await Promise.all([
    deps.rows.list(org, tableId, { limit, offset, query, columns: refs }),
    deps.rows.count(org, tableId, { query, columns: refs }),
    deps.rows.count(org, tableId),
    offset === 0 && input.coverage !== false ? deps.structure.columnCoverage(org, tableId, columns.map((c) => c.key)) : Promise.resolve({} as Record<string, number>),
    deps.rows.activeJobs(org, tableId),
  ]);
  return { table, columns, rows, total, unfilteredTotal, cursor, coverage, activeJobs, view: resolved.view, defaultView: resolved.defaultView, personalView: resolved.personal, canEditDefault: resolved.canEditDefault };
}

/** Rows in table order, without the saved view. */
export async function listRows(deps: Deps, actor: Actor, tableId: string, input: { limit?: number; offset?: number } = {}) {
  const { columns } = await loadTable(deps, actor, tableId);
  const limit = Math.min(Math.max(1, input.limit ?? GRID_LIMITS.defaultPageSize), GRID_LIMITS.pageSize);
  return { rows: await deps.rows.list(actor.organizationId, tableId, { limit, offset: Math.max(0, input.offset ?? 0), columns: refsOf(columns) }) };
}

/** Appends blank rows. */
export async function addRows(deps: Deps, actor: Actor, tableId: string, count: unknown) {
  const n = Number(count ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > GRID_LIMITS.addRows) throw new ValidationError(`count must be a whole number from 1 to ${GRID_LIMITS.addRows}`);
  await loadTable(deps, actor, tableId);
  return { rows: await deps.rows.addBlank(actor.organizationId, tableId, n, GRID_LIMITS.tableRows) };
}

export async function deleteRows(deps: Deps, actor: Actor, tableId: string, rowIds: string[]) {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) throw new ValidationError("rowIds must be a non-empty array");
  if (ids.length > GRID_LIMITS.deleteRows) throw new ValidationError(`Delete up to ${GRID_LIMITS.deleteRows} rows at a time`);
  const { table } = await loadTable(deps, actor, tableId);
  const deleted = await deps.rows.delete(actor.organizationId, tableId, ids);
  if (deleted > 0) await refreshAfterSourceWrite(deps, actor.organizationId, table);
  return { deleted };
}

/** Row ids matching the member's view and an optional search. This is what "select all matching rows" reads. */
export async function selectRows(deps: Deps, actor: Actor, tableId: string, input: { search?: string } = {}) {
  const { table, columns } = await loadTable(deps, actor, tableId);
  const rowIds = await deps.rows.listIds(actor.organizationId, tableId, {
    query: queryOf((await resolveView(deps, actor, table, columns)).view, input.search),
    columns: refsOf(columns),
    limit: GRID_LIMITS.selection,
  });
  return { rowIds, truncated: rowIds.length >= GRID_LIMITS.selection };
}

/**
 * Rows written since `cursor`, the new cursor, `hasMore` and how many jobs are still active. Clients poll
 * while `activeJobs` is above zero, and again at once while `hasMore` is true.
 */
export async function getChanges(deps: Deps, actor: Actor, tableId: string, cursor: string) {
  if (typeof cursor !== "string" || !parseChangeCursor(cursor)) throw new ValidationError("cursor must be the cursor the table or the last changes call returned");
  if (!(await deps.structure.getTable(actor.organizationId, tableId))) throw new NotFoundError("Table not found");
  return deps.rows.changesSince(actor.organizationId, tableId, cursor, 500);
}

export interface CellUpdateInput {
  rowId: string;
  columnKey: string;
  value: unknown;
  /** The row version the client last saw. A stale one makes the whole request fail with 409 and write nothing. */
  expectedVersion?: number;
  /**
   * Compare-and-set: the value the client believes the cell holds. A cell that holds something else is left alone
   * and comes back in `skipped`. Undo and redo use it so they never overwrite another person's later edit.
   */
  expect?: { value: unknown };
}

export interface EditCellsOptions {
  /**
   * The write restores an earlier value (undo or redo). It starts no auto-run, which would spend money on a
   * value the person is taking back; the runner columns that read the cells are marked stale instead.
   */
  undo?: boolean;
}

/**
 * Writes cell values. Only static columns are editable: a runner column's value belongs to its runner,
 * and an edit would be overwritten by the next run.
 */
export async function editCells(deps: Deps, actor: Actor, tableId: string, updates: CellUpdateInput[], options: EditCellsOptions = {}) {
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > GRID_LIMITS.cellUpdates) {
    throw new ValidationError(`Send between 1 and ${GRID_LIMITS.cellUpdates.toLocaleString("en-US")} cell updates`);
  }
  const { table, columns } = await loadTable(deps, actor, tableId);
  const byKey = new Map(columns.map((c) => [c.key, c]));

  const seen = new Set<string>();
  const edits = new Map<string, CellEdit>();
  // An undo or redo restores what a person did earlier, and the table may have changed since (a column deleted or
  // turned into a runner column). Those cells are skipped and reported; refusing the request would drop the whole action.
  const unrestorable: SkippedCell[] = [];
  for (const update of updates) {
    if (!update || typeof update.rowId !== "string" || typeof update.columnKey !== "string") throw new ValidationError("Every update needs a rowId and columnKey");
    const cell = `${update.rowId}\u0000${update.columnKey}`;
    if (seen.has(cell)) throw new ValidationError("Updates cannot contain the same cell twice");
    seen.add(cell);
    const column = byKey.get(update.columnKey);
    if (!column) {
      if (options.undo) {
        unrestorable.push({ rowId: update.rowId, columnKey: update.columnKey, current: null });
        continue;
      }
      throw new ValidationError(`Unknown column "${update.columnKey}"`);
    }
    if (!isStaticColumnType(column.type)) {
      if (options.undo) {
        unrestorable.push({ rowId: update.rowId, columnKey: update.columnKey, current: null });
        continue;
      }
      throw new ValidationError(column.type === "formula" ? `"${column.name}" is a formula column. It calculates from its formula, so edit the formula to change it.` : `"${column.name}" is filled by a run. Run its column to change this value.`);
    }

    const input = coerceCellInput(update.value, column.type);
    if (!input.ok) {
      if (options.undo) {
        unrestorable.push({ rowId: update.rowId, columnKey: update.columnKey, current: null });
        continue;
      }
      throw new ValidationError(`"${column.name}" ${input.error}.`);
    }

    if (update.expectedVersion !== undefined && (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 0)) {
      throw new ValidationError("expectedVersion must be a non-negative whole number");
    }
    const edit = edits.get(update.rowId) ?? { rowId: update.rowId, set: {}, expectedVersion: undefined };
    if (update.expectedVersion !== undefined) {
      if (edit.expectedVersion !== undefined && edit.expectedVersion !== update.expectedVersion) throw new ValidationError("Updates to one row must name the same expectedVersion");
      edit.expectedVersion = update.expectedVersion;
    }
    edit.set[update.columnKey] = input.value;
    if (update.expect) edit.expected = { ...edit.expected, [update.columnKey]: update.expect.value };
    edits.set(update.rowId, edit);
    if (edits.size > GRID_LIMITS.cellUpdateRows) throw new ValidationError(`Updates cannot span more than ${GRID_LIMITS.cellUpdateRows.toLocaleString("en-US")} rows`);
  }

  const stored = edits.size === 0 ? { rows: [], previous: new Map<string, Record<string, unknown>>(), skipped: [] as SkippedCell[] } : await deps.rows.applyEdits(actor.organizationId, tableId, [...edits.values()]);
  const result = { ...stored, skipped: [...stored.skipped, ...unrestorable] };

  const skippedCells = new Set(result.skipped.map((s) => `${s.rowId}\u0000${s.columnKey}`));
  const applied: Array<{ rowId: string; columnKey: string; value: unknown }> = [];
  const changed: CellChange[] = [];
  for (const edit of edits.values()) {
    const before = result.previous.get(edit.rowId) ?? {};
    for (const [columnKey, value] of Object.entries(edit.set)) {
      if (skippedCells.has(`${edit.rowId}\u0000${columnKey}`)) continue;
      applied.push({ rowId: edit.rowId, columnKey, value: value ?? null });
      const previous = before[columnKey] ?? null;
      if (JSON.stringify(previous) !== JSON.stringify(value ?? null)) changed.push({ rowId: edit.rowId, columnKey, previous, value });
    }
  }
  let queued = 0;
  let skippedByCap = 0;
  if (options.undo) {
    await markDependentsStale(deps, actor.organizationId, tableId, columns, changed);
  } else {
    ({ queued, skippedByCap } = await notifyCellsChanged({ organizationId: actor.organizationId, tableId, userId: actor.userId, changes: changed }));
  }
  let rows = result.rows as RowRecord[];
  const recalculated = await recalculateFormulasQuietly(deps, actor.organizationId, tableId, { rowIds: rows.map((r) => r.id), changedKeys: changed.map((c) => c.columnKey) });
  // Formulas in other tables that look up the edited columns.
  const lookups = changed.length > 0 ? await refreshAfterSourceWrite(deps, actor.organizationId, table, [...new Set(changed.map((c) => c.columnKey))]) : null;
  if (recalculated > 0 || (lookups && lookups.recalculated + lookups.stale > 0)) rows = (await deps.rows.listByIds(actor.organizationId, tableId, rows.map((r) => r.id))) as RowRecord[];
  return { updatedCells: updates.length, rows, queued, skippedByCap, applied, skipped: result.skipped };
}

/**
 * Runner columns (enrichment, AI and the like) that read a changed cell keep their old result, which no longer
 * matches its input. Formulas are not marked: the recalculation that follows the write refreshes them.
 */
async function markDependentsStale(deps: Deps, organizationId: string, tableId: string, columns: ReadonlyArray<ColumnRecord>, changed: ReadonlyArray<CellChange>) {
  if (changed.length === 0) return;
  const keys = new Set(changed.map((c) => c.columnKey));
  const dependents = columns.filter((c) => !isStaticColumnType(c.type) && c.type !== "formula" && c.type !== "ai_output" && c.type !== "integration_output" && c.dependsOn.some((key) => keys.has(key)));
  if (dependents.length === 0) return;
  const rowIds = [...new Set(changed.map((c) => c.rowId))];
  await deps.rows.markStale(organizationId, tableId, dependents.map((c) => c.key), "An input cell was restored by undo. Run this column to refresh it.", rowIds);
}
