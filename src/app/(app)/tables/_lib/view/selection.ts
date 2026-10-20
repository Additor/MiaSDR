/** Selection math for the grid. Pure, so keyboard behavior is testable without a DOM. */

export interface CellPos {
  row: number;
  col: number;
}

export interface CellRange {
  anchor: CellPos;
  focus: CellPos;
}

export interface Bounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface Dims {
  rows: number;
  cols: number;
}

export const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export const clampPos = (pos: CellPos, dims: Dims): CellPos => ({
  row: clamp(pos.row, 0, Math.max(0, dims.rows - 1)),
  col: clamp(pos.col, 0, Math.max(0, dims.cols - 1)),
});

export function boundsOf(range: CellRange): Bounds {
  return {
    r0: Math.min(range.anchor.row, range.focus.row),
    r1: Math.max(range.anchor.row, range.focus.row),
    c0: Math.min(range.anchor.col, range.focus.col),
    c1: Math.max(range.anchor.col, range.focus.col),
  };
}

export const inBounds = (b: Bounds, pos: CellPos) => pos.row >= b.r0 && pos.row <= b.r1 && pos.col >= b.c0 && pos.col <= b.c1;

export const cellCount = (b: Bounds) => (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1);

export const single = (pos: CellPos): CellRange => ({ anchor: pos, focus: pos });

export interface MoveOptions {
  /** Ctrl or Cmd: jump to the edge. */
  jump?: boolean;
  pageSize?: number;
}

/** Where a navigation key leads from `pos`. Null when the key does not navigate. */
export function movePos(pos: CellPos, key: string, dims: Dims, options: MoveOptions = {}): CellPos | null {
  const lastRow = dims.rows - 1;
  const lastCol = dims.cols - 1;
  if (lastRow < 0 || lastCol < 0) return null;
  const page = Math.max(1, options.pageSize ?? 10);
  switch (key) {
    case "ArrowUp":
      return clampPos({ row: options.jump ? 0 : pos.row - 1, col: pos.col }, dims);
    case "ArrowDown":
      return clampPos({ row: options.jump ? lastRow : pos.row + 1, col: pos.col }, dims);
    case "ArrowLeft":
      return clampPos({ row: pos.row, col: options.jump ? 0 : pos.col - 1 }, dims);
    case "ArrowRight":
      return clampPos({ row: pos.row, col: options.jump ? lastCol : pos.col + 1 }, dims);
    case "PageUp":
      return clampPos({ row: pos.row - page, col: pos.col }, dims);
    case "PageDown":
      return clampPos({ row: pos.row + page, col: pos.col }, dims);
    case "Home":
      return options.jump ? { row: 0, col: 0 } : { row: pos.row, col: 0 };
    case "End":
      return options.jump ? { row: lastRow, col: lastCol } : { row: pos.row, col: lastCol };
    default:
      return null;
  }
}

/** Tab order: right along the row, wrapping to the next row. Shift+Tab goes back. Stays put at the ends. */
export function tabPos(pos: CellPos, dims: Dims, backwards: boolean): CellPos {
  if (backwards) {
    if (pos.col > 0) return { row: pos.row, col: pos.col - 1 };
    return pos.row > 0 ? { row: pos.row - 1, col: dims.cols - 1 } : pos;
  }
  if (pos.col < dims.cols - 1) return { row: pos.row, col: pos.col + 1 };
  return pos.row < dims.rows - 1 ? { row: pos.row + 1, col: 0 } : pos;
}

/** Extends a range by moving its focus end; the anchor stays. */
export const extendRange = (range: CellRange, focus: CellPos): CellRange => ({ anchor: range.anchor, focus });

/** Row checkbox selection, kept as ids so it survives scrolling and polling. */
export interface RowSelection {
  ids: ReadonlySet<string>;
  /** Index of the row last clicked, the start of a shift-click range. */
  anchor: number | null;
}

export const emptySelection: RowSelection = { ids: new Set(), anchor: null };

export function toggleRow(sel: RowSelection, rowIds: readonly string[], index: number, options: { range?: boolean } = {}): RowSelection {
  const id = rowIds[index];
  if (id === undefined) return sel;
  const next = new Set(sel.ids);
  if (options.range && sel.anchor !== null && rowIds[sel.anchor] !== undefined) {
    const [from, to] = sel.anchor < index ? [sel.anchor, index] : [index, sel.anchor];
    // A shift-click adds the range in the state the clicked row ends up in.
    const add = !sel.ids.has(id);
    for (let i = from; i <= to; i++) {
      if (add) next.add(rowIds[i]);
      else next.delete(rowIds[i]);
    }
    return { ids: next, anchor: index };
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { ids: next, anchor: index };
}

export function selectAllLoaded(rowIds: readonly string[]): RowSelection {
  return { ids: new Set(rowIds), anchor: null };
}

/** The header checkbox state for the rows currently loaded. */
export function headerState(sel: RowSelection, rowIds: readonly string[]): "none" | "some" | "all" {
  if (rowIds.length === 0 || sel.ids.size === 0) return "none";
  let hit = 0;
  for (const id of rowIds) if (sel.ids.has(id)) hit += 1;
  if (hit === 0) return "none";
  return hit === rowIds.length ? "all" : "some";
}

/** Drops ids that are no longer part of the table. */
export function pruneSelection(sel: RowSelection, existing: ReadonlySet<string>): RowSelection {
  let changed = false;
  const ids = new Set<string>();
  for (const id of sel.ids) {
    if (existing.has(id)) ids.add(id);
    else changed = true;
  }
  return changed ? { ids, anchor: sel.anchor } : sel;
}
