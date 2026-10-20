/** Row windowing for the grid. Rows have a fixed height, so the visible slice is arithmetic. */

export interface RowWindow {
  start: number;
  /** Exclusive. */
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function rowWindow(input: { scrollTop: number; viewportHeight: number; rowHeight: number; count: number; overscan?: number }): RowWindow {
  const { rowHeight, count } = input;
  const overscan = input.overscan ?? 8;
  const totalHeight = count * rowHeight;
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  const first = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, input.scrollTop) + Math.max(0, input.viewportHeight)) / rowHeight);
  const start = Math.min(Math.max(0, first - overscan), count - 1);
  const end = Math.min(count, Math.max(start + 1, last + overscan));
  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/** Scroll position that brings a row fully into view, or null when it already is. */
export function scrollToRow(input: { row: number; scrollTop: number; viewportHeight: number; rowHeight: number; headerHeight?: number }): number | null {
  const header = input.headerHeight ?? 0;
  const top = input.row * input.rowHeight;
  const bottom = top + input.rowHeight;
  const visibleTop = input.scrollTop;
  const visibleBottom = input.scrollTop + input.viewportHeight - header;
  if (top < visibleTop) return top;
  if (bottom > visibleBottom) return bottom - (input.viewportHeight - header);
  return null;
}
