import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import type { CellEditInput, GridRow, RowConflict } from "../data/types";

/** A cell edit the user made that the server has not confirmed. */
export interface PendingEdit extends CellEditInput {
  /** Row version the edit was made against. */
  baseVersion: number;
  /** The undo step this edit belongs to. A later edit of the same cell takes the cell over. */
  actionId?: string;
}

export const cellId = (rowId: string, columnKey: string) => `${rowId}\u0000${columnKey}`;

export type PendingMap = ReadonlyMap<string, PendingEdit>;

/** Shows pending values on top of the rows the server last sent. */
export function overlayPending(rows: readonly GridRow[], pending: PendingMap): GridRow[] {
  if (pending.size === 0) return rows as GridRow[];
  const byRow = new Map<string, PendingEdit[]>();
  for (const edit of pending.values()) {
    const list = byRow.get(edit.rowId) ?? [];
    list.push(edit);
    byRow.set(edit.rowId, list);
  }
  return rows.map((row) => {
    const edits = byRow.get(row.id);
    if (!edits) return row;
    const cells = { ...row.cells };
    for (const edit of edits) cells[edit.columnKey] = edit.value;
    return { ...row, cells };
  });
}

/** Queues an edit. A second edit to the same cell replaces the first but keeps the older base version. */
export function addPending(pending: PendingMap, edit: CellEditInput, row: GridRow | undefined, actionId?: string): Map<string, PendingEdit> {
  const next = new Map(pending);
  const key = cellId(edit.rowId, edit.columnKey);
  const existing = next.get(key);
  next.set(key, { ...edit, baseVersion: existing?.baseVersion ?? row?.version ?? 0, actionId });
  return next;
}

export interface EditBatch {
  updates: Array<CellEditInput & { expectedVersion: number }>;
}

/** Most cells and rows one cells request may carry. */
export const BATCH_LIMITS = { cells: GRID_LIMITS.cellUpdates, rows: GRID_LIMITS.cellUpdateRows } as const;

/**
 * The pending edits as requests the server accepts: whole rows per request (a row's updates share one version),
 * at most `limits.cells` cells and `limits.rows` rows each, in the order the edits were made. A paste of
 * 6,000 cells goes out as two requests instead of failing with 422.
 */
export function buildBatches(pending: PendingMap, rows: readonly GridRow[], limits: { cells: number; rows: number } = BATCH_LIMITS): EditBatch[] {
  const versions = new Map(rows.map((r) => [r.id, r.version]));
  const updates: EditBatch["updates"] = [];
  for (const edit of pending.values()) updates.push({ rowId: edit.rowId, columnKey: edit.columnKey, value: edit.value, expectedVersion: versions.get(edit.rowId) ?? edit.baseVersion });
  return splitByRows(updates, limits).map((part) => ({ updates: part }));
}

/** Splits items into groups of whole rows, each with at most `limits.cells` items and `limits.rows` rows. Order is kept. */
export function splitByRows<T extends { rowId: string }>(items: readonly T[], limits: { cells: number; rows: number } = BATCH_LIMITS): T[][] {
  const byRow = new Map<string, T[]>();
  for (const item of items) {
    const list = byRow.get(item.rowId);
    if (list) list.push(item);
    else byRow.set(item.rowId, [item]);
  }
  const groups: T[][] = [];
  let current: T[] = [];
  let currentRows = 0;
  for (const list of byRow.values()) {
    if (current.length > 0 && (current.length + list.length > limits.cells || currentRows + 1 > limits.rows)) {
      groups.push(current);
      current = [];
      currentRows = 0;
    }
    current.push(...list);
    currentRows += 1;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Folds rows from the server into the loaded rows. A row replaces its old copy only when its version is not
 * older, so a slow poll cannot undo an edit response. Rows the client has not loaded are appended when the
 * client holds the whole table in table order, and reported otherwise.
 */
export function mergeRows(existing: readonly GridRow[], incoming: readonly GridRow[], options: { canAppend: boolean }): { rows: GridRow[]; unplaced: number; changed: boolean } {
  const index = new Map(existing.map((row, i) => [row.id, i]));
  const rows = existing.slice();
  const appended: GridRow[] = [];
  let unplaced = 0;
  let changed = false;
  for (const row of incoming) {
    const at = index.get(row.id);
    if (at === undefined) {
      if (options.canAppend) appended.push(row);
      else unplaced += 1;
      continue;
    }
    if (row.version > rows[at].version) {
      rows[at] = row;
      changed = true;
    }
  }
  if (appended.length > 0) {
    rows.push(...appended.sort((a, b) => a.position - b.position));
    changed = true;
  }
  return { rows, unplaced, changed };
}

export interface ConflictItem {
  rowId: string;
  columnKey: string;
  /** What the user typed. */
  mine: unknown;
  /** What the row holds now. Undefined when the row was deleted. */
  theirs: unknown;
  deleted: boolean;
  currentVersion: number | null;
}

/** Pairs each rejected edit with the value now in the row, for the conflict dialog. */
export function conflictItems(conflicts: readonly RowConflict[], pending: PendingMap): ConflictItem[] {
  const byRow = new Map(conflicts.map((c) => [c.rowId, c]));
  const items: ConflictItem[] = [];
  for (const edit of pending.values()) {
    const conflict = byRow.get(edit.rowId);
    if (!conflict) continue;
    items.push({
      rowId: edit.rowId,
      columnKey: edit.columnKey,
      mine: edit.value,
      theirs: conflict.cells?.[edit.columnKey],
      deleted: conflict.cells === null,
      currentVersion: conflict.currentVersion,
    });
  }
  return items;
}

/** Overwrites the cached rows' cells and versions with what a 409 reported, so a retry names the current version. */
export function applyConflictRows(rows: readonly GridRow[], conflicts: readonly RowConflict[]): GridRow[] {
  const byRow = new Map(conflicts.map((c) => [c.rowId, c]));
  return rows.map((row) => {
    const c = byRow.get(row.id);
    if (!c || c.cells === null || c.currentVersion === null) return row;
    return { ...row, cells: c.cells, version: c.currentVersion };
  });
}

/** Drops edits that a response confirmed. */
export function clearPending(pending: PendingMap, updates: readonly CellEditInput[]): Map<string, PendingEdit> {
  const next = new Map(pending);
  for (const u of updates) {
    const key = cellId(u.rowId, u.columnKey);
    const current = next.get(key);
    // An edit made while the request was in flight has a different value and stays queued.
    if (current && Object.is(current.value, u.value)) next.delete(key);
  }
  return next;
}
