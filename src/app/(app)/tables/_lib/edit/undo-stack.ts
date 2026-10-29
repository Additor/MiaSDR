/**
 * Undo and redo for cell edits. Pure data: the hook that owns the grid keeps one stack and sends the requests.
 *
 * An action is one thing a person did (a typed value, a clear, a paste), however many cells and requests it took.
 * Each cell holds both sides: undo writes `before` and expects `after` to be stored, redo does the reverse. The
 * server compares per cell, so a cell someone else changed in the meantime is skipped, never overwritten. After
 * each write the written side is replaced with the value the server stored, because the server coerces what it gets
 * (`"42"` becomes `42`), and the next compare must use that value.
 */

export interface UndoCell {
  rowId: string;
  columnKey: string;
  before: unknown;
  after: unknown;
}

export interface UndoAction {
  id: string;
  cells: UndoCell[];
}

export interface UndoStack {
  /** Oldest first. Undo takes the last one. */
  done: readonly UndoAction[];
  /** Actions that were undone, oldest first. Redo takes the last one. */
  undone: readonly UndoAction[];
}

export type Direction = "undo" | "redo";

export const EMPTY_STACK: UndoStack = { done: [], undone: [] };

export const MAX_ACTIONS = 100;
export const MAX_CELLS = 50_000;

const keyOf = (rowId: string, columnKey: string) => `${rowId}\u0000${columnKey}`;
const empty = (value: unknown) => value === null || value === undefined || value === "";

/** Same value for history purposes. An empty cell may be null, missing or an empty string. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export const canUndo = (stack: UndoStack) => stack.done.length > 0;
export const canRedo = (stack: UndoStack) => stack.undone.length > 0;

function trim(done: readonly UndoAction[]): readonly UndoAction[] {
  let list = done.length > MAX_ACTIONS ? done.slice(done.length - MAX_ACTIONS) : done;
  let cells = list.reduce((n, a) => n + a.cells.length, 0);
  while (cells > MAX_CELLS && list.length > 1) {
    cells -= list[0].cells.length;
    list = list.slice(1);
  }
  return list;
}

/**
 * Adds an action. Cells whose value does not change are left out. An action with the same id as the newest one
 * (a paste sent in several calls) joins it: the first `before` stays and the later `after` wins. A new action
 * ends the redo history.
 */
export function record(stack: UndoStack, id: string, cells: readonly UndoCell[]): UndoStack {
  const real = cells.filter((c) => !sameValue(c.before, c.after));
  if (real.length === 0) return stack;
  const top = stack.done[stack.done.length - 1];
  if (top && top.id === id) {
    const merged = new Map(top.cells.map((c) => [keyOf(c.rowId, c.columnKey), c]));
    for (const cell of real) {
      const known = merged.get(keyOf(cell.rowId, cell.columnKey));
      merged.set(keyOf(cell.rowId, cell.columnKey), known ? { ...cell, before: known.before } : cell);
    }
    const cellsOut = [...merged.values()].filter((c) => !sameValue(c.before, c.after));
    const done = cellsOut.length > 0 ? [...stack.done.slice(0, -1), { id, cells: cellsOut }] : stack.done.slice(0, -1);
    return { done: trim(done), undone: [] };
  }
  return { done: trim([...stack.done, { id, cells: real }]), undone: [] };
}

export interface WrittenCell {
  rowId: string;
  columnKey: string;
  /** What the server stored. */
  value: unknown;
}

/**
 * Replaces the typed `after` of a recorded action with the value the server stored, for edits made through the
 * pending queue. A cell whose stored value equals its `before` changed nothing and leaves the action.
 */
export function settleAfter(stack: UndoStack, actionId: string, written: readonly WrittenCell[]): UndoStack {
  const byCell = new Map(written.map((w) => [keyOf(w.rowId, w.columnKey), w.value]));
  const done = stack.done
    .map((action) => {
      if (action.id !== actionId) return action;
      const cells = action.cells.map((c) => (byCell.has(keyOf(c.rowId, c.columnKey)) ? { ...c, after: byCell.get(keyOf(c.rowId, c.columnKey)) } : c)).filter((c) => !sameValue(c.before, c.after));
      return { ...action, cells };
    })
    .filter((action) => action.cells.length > 0);
  return { ...stack, done };
}

/** Removes cells from an action, for edits the server refused. */
export function discardCells(stack: UndoStack, actionId: string, cells: ReadonlyArray<{ rowId: string; columnKey: string }>): UndoStack {
  const gone = new Set(cells.map((c) => keyOf(c.rowId, c.columnKey)));
  const done = stack.done
    .map((action) => (action.id === actionId ? { ...action, cells: action.cells.filter((c) => !gone.has(keyOf(c.rowId, c.columnKey))) } : action))
    .filter((action) => action.cells.length > 0);
  return { ...stack, done };
}

/** Removes the cells of deleted rows from every action, undone ones included. An action left empty is gone. */
export function discardRows(stack: UndoStack, rowIds: Iterable<string>): UndoStack {
  const gone = new Set(rowIds);
  const keep = (list: readonly UndoAction[]) => list.map((action) => ({ ...action, cells: action.cells.filter((c) => !gone.has(c.rowId)) })).filter((action) => action.cells.length > 0);
  return { done: keep(stack.done), undone: keep(stack.undone) };
}

/** The action the next undo or redo would apply. */
export function nextAction(stack: UndoStack, direction: Direction): UndoAction | undefined {
  const list = direction === "undo" ? stack.done : stack.undone;
  return list[list.length - 1];
}

export interface RestoreUpdate {
  rowId: string;
  columnKey: string;
  /** Written to the cell. */
  value: unknown;
  /** What the cell must hold for the write to apply. */
  expected: unknown;
}

/** The cell writes that carry out an undo or a redo. */
export function restoreUpdates(action: UndoAction, direction: Direction): RestoreUpdate[] {
  return action.cells.map((c) => (direction === "undo" ? { rowId: c.rowId, columnKey: c.columnKey, value: c.before, expected: c.after } : { rowId: c.rowId, columnKey: c.columnKey, value: c.after, expected: c.before }));
}

/**
 * Moves an action to the other side after its writes ran. Only cells the server applied move, with the stored
 * value on the written side. When nothing applied, the action is gone.
 */
export function complete(stack: UndoStack, direction: Direction, actionId: string, written: readonly WrittenCell[]): UndoStack {
  const source = direction === "undo" ? stack.done : stack.undone;
  const target = direction === "undo" ? stack.undone : stack.done;
  const action = source.find((a) => a.id === actionId);
  if (!action) return stack;
  const byCell = new Map(written.map((w) => [keyOf(w.rowId, w.columnKey), w.value]));
  const cells: UndoCell[] = [];
  for (const c of action.cells) {
    const key = keyOf(c.rowId, c.columnKey);
    if (!byCell.has(key)) continue;
    cells.push(direction === "undo" ? { ...c, before: byCell.get(key) } : { ...c, after: byCell.get(key) });
  }
  const rest = source.filter((a) => a.id !== actionId);
  const moved = cells.length > 0 ? [...target.filter((a) => a.id !== actionId), { id: actionId, cells }] : target;
  return direction === "undo" ? { done: rest, undone: moved } : { done: trim(moved), undone: rest };
}

/** Removes an action that cannot run any more (its column is gone, the server refused it). */
export function drop(stack: UndoStack, direction: Direction, actionId: string): UndoStack {
  return direction === "undo" ? { ...stack, done: stack.done.filter((a) => a.id !== actionId) } : { ...stack, undone: stack.undone.filter((a) => a.id !== actionId) };
}

/**
 * True when the column set changed in a way that makes recorded values wrong: a column was deleted or its type
 * changed (values convert). Added or renamed columns do not matter.
 */
export function columnsInvalidate(before: ReadonlyArray<{ key: string; type: string }>, after: ReadonlyArray<{ key: string; type: string }>): boolean {
  if (before.length === 0) return false;
  const now = new Map(after.map((c) => [c.key, c.type]));
  return before.some((c) => now.get(c.key) !== c.type);
}
