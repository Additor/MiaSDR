"use client";

import { AlertCircleIcon, ArrowDownIcon, ArrowUpIcon, CircleDashedIcon, Clock3Icon, ExpandIcon, Loader2Icon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { cn } from "@/components/ui/utils";
import { cellStatus, columnWidth, displayValue, editorText, isEditableColumn, selectOptions, typeLabel, columnRunSummary, missingInputHint } from "../_lib/view/format";
import { planFill } from "../_lib/edit/fill";
import { historyKey } from "../_lib/view/keymap";
import { clipboardCell, parseClipboard, routePaste, serializeClipboard, skippedCellsText, type BlockPasteRequest } from "../_lib/edit/paste";
import { boundsOf, clampPos, extendRange, headerState, inBounds, movePos, single, tabPos, toggleRow, type CellPos, type CellRange, type RowSelection } from "../_lib/view/selection";
import type { CellEditInput, GridColumn, GridRow } from "../_lib/data/types";
import { rowWindow, scrollToRow } from "../_lib/view/window";
import { CellEditor, type CommitMove } from "./cell-editor";
import { ColumnMenu, type ColumnAction } from "./column-menu";

/** Divider after the last pinned column. */
const PIN_EDGE = "shadow-[2px_0_4px_-2px_color-mix(in_oklab,var(--foreground)_20%,transparent)]";
const ROW_H = 32;
const HEADER_H = 36;
const GUTTER_W = 72;

export interface ActiveCell {
  row: GridRow;
  column: GridColumn;
}

interface Props {
  label: string;
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  selection: RowSelection;
  onSelection: (next: RowSelection) => void;
  sorts: Map<string, "asc" | "desc">;
  onEdit: (edits: CellEditInput[]) => void;
  onUndo: () => void;
  /** True when the rows shown are the table in table order, which a paste needs to add rows or columns. */
  keepsOrder: boolean;
  /** How many of the leading columns are pinned: they stay in view while the rest scroll sideways. */
  pinnedCount?: number;
  /** Every pinned column key, for the column menu. */
  pinnedKeys?: readonly string[];
  /** Percent of rows with a value, per column key. Counted when the table loads, so it can lag behind edits. */
  coverage?: Record<string, number>;
  onPasteBlock: (request: BlockPasteRequest) => void;
  onRedo: () => void;
  onColumnAction: (column: GridColumn, action: ColumnAction) => void;
  onLoadMore: () => void;
  onActiveChange: (cell: ActiveCell | null) => void;
  onOpenDetails: (cell: ActiveCell) => void;
  /** Runs the run that fills this cell (Ctrl or Cmd+Enter, or the run button of the active cell). */
  onRunCell?: (cell: ActiveCell) => void;
  /** True for a cell that has a run of its own: a runner column, or an output column of one. */
  canRunCell?: (column: GridColumn) => boolean;
  /** Bumps when the parent wants the grid to take focus back (after a dialog closes). */
  focusToken: number;
  /** A column to bring into view and select, such as one just added. A new token asks again. */
  reveal?: { key: string; token: number } | null;
  /** Shown under the header when the grid has no rows, such as an empty state with a next step. */
  empty?: ReactNode;
}

interface Editing {
  pos: CellPos;
  initial: string | null;
}

/** The spreadsheet: roving selection, typed editors, clipboard, and a window of rows rendered at a time. */
export function DataGrid(props: Props) {
  const { columns, rows, total, selection, sorts } = props;
  const { onSelection, onEdit, onLoadMore, onActiveChange, onOpenDetails } = props;
  const pinnedCount = Math.min(props.pinnedCount ?? 0, columns.length);
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 480 });
  const [range, setRange] = useState<CellRange>(single({ row: 0, col: 0 }));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const dragging = useRef(false);
  // Drag-down fill: the selection it copies and the last row the drag reached.
  const fill = useRef<{ source: { r0: number; r1: number; c0: number; c1: number } } | null>(null);
  const [fillTo, setFillTo] = useState<number | null>(null);

  const widthOf = useCallback((c: GridColumn) => widths[c.key] ?? columnWidth(c), [widths]);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let x = 0;
    for (const c of columns) {
      out.push(x);
      x += widths[c.key] ?? columnWidth(c);
    }
    return { left: out, total: x };
  }, [columns, widths]);

  const dims = useMemo(() => ({ rows: rows.length, cols: columns.length }), [rows.length, columns.length]);
  const active = useMemo(() => clampPos(range.focus, dims), [range.focus, dims]);
  const bounds = useMemo(() => boundsOf({ anchor: clampPos(range.anchor, dims), focus: active }), [range.anchor, active, dims]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setScroll((s) => (s.height === el.clientHeight ? s : { ...s, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const win = rowWindow({ scrollTop: scroll.top, viewportHeight: Math.max(0, scroll.height - HEADER_H), rowHeight: ROW_H, count: rows.length });

  useEffect(() => {
    if (win.end >= rows.length - 30 && rows.length < total) onLoadMore();
  }, [win.end, rows.length, total, onLoadMore]);

  const activeRow = rows[active.row];
  const activeColumn = columns[active.col];
  useEffect(() => {
    onActiveChange(activeRow && activeColumn ? { row: activeRow, column: activeColumn } : null);
    // Report the position, not every row object, so polling does not re-render the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow?.id, activeColumn?.key, onActiveChange]);

  const focusGrid = useCallback(() => scroller.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (props.focusToken > 0) focusGrid();
  }, [props.focusToken, focusGrid]);

  const reveal = useCallback(
    (pos: CellPos) => {
      const el = scroller.current;
      if (!el) return;
      const top = scrollToRow({ row: pos.row, scrollTop: el.scrollTop, viewportHeight: el.clientHeight, rowHeight: ROW_H, headerHeight: HEADER_H });
      if (top !== null) el.scrollTop = top;
      const left = offsets.left[pos.col];
      const column = columns[pos.col];
      if (left === undefined || !column) return;
      const width = widths[column.key] ?? columnWidth(column);
      const viewRight = el.scrollLeft + el.clientWidth;
      // A pinned column never scrolls away. The others scroll in the room to its right.
      if (pos.col < pinnedCount) return;
      const pinnedWidth = offsets.left[pinnedCount] ?? 0;
      if (left - pinnedWidth < el.scrollLeft) el.scrollLeft = left - pinnedWidth;
      else if (left + GUTTER_W + width > viewRight) el.scrollLeft = left + GUTTER_W + width - el.clientWidth;
    },
    [offsets.left, columns, widths, pinnedCount],
  );

  const moveTo = useCallback(
    (pos: CellPos, extend: boolean) => {
      const next = clampPos(pos, dims);
      setRange((r) => (extend ? extendRange(r, next) : single(next)));
      reveal(next);
    },
    [dims, reveal],
  );

  // A column just added lands on the right, often off screen: select its first cell and scroll it into view.
  const revealToken = props.reveal?.token;
  useEffect(() => {
    const key = props.reveal?.key;
    const col = key ? columns.findIndex((c) => c.key === key) : -1;
    if (col < 0) return;
    const frame = requestAnimationFrame(() => {
      moveTo({ row: 0, col }, false);
      focusGrid();
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per token: the column list changing later must not move the selection again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  const pinnedKeys = props.pinnedKeys ?? [];
  // The column menus' result lines, counted once per change of rows or columns, not on every render of the header.
  const summaries = useMemo(() => new Map(columns.map((c) => [c.key, columnRunSummary(c, rows, rows.length < total)] as const)), [columns, rows, total]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const clearRange = useCallback(() => {
    const edits: CellEditInput[] = [];
    for (let r = bounds.r0; r <= bounds.r1; r++) {
      for (let c = bounds.c0; c <= bounds.c1; c++) {
        const row = rows[r];
        const column = columns[c];
        if (!row || !column || !isEditableColumn(column)) continue;
        if (row.cells[column.key] !== null && row.cells[column.key] !== undefined) edits.push({ rowId: row.id, columnKey: column.key, value: null });
      }
    }
    onEdit(edits);
  }, [bounds, rows, columns, onEdit]);

  const copyRange = useCallback(() => {
    const matrix: string[][] = [];
    for (let r = bounds.r0; r <= bounds.r1; r++) {
      const line: string[] = [];
      for (let c = bounds.c0; c <= bounds.c1; c++) line.push(clipboardCell(rows[r]?.cells[columns[c]?.key] ?? null));
      matrix.push(line);
    }
    return serializeClipboard(matrix);
  }, [bounds, rows, columns]);

  const commit = useCallback(
    (pos: CellPos, value: string | boolean | null, move: CommitMove) => {
      const row = rows[pos.row];
      const column = columns[pos.col];
      setEditing(null);
      if (row && column) {
        const before = row.cells[column.key];
        const same = (before ?? null) === value || (typeof before !== "string" && value !== null && editorText(before) === value);
        if (!same) onEdit([{ rowId: row.id, columnKey: column.key, value }]);
      }
      focusGrid();
      if (move === "down") moveTo({ row: pos.row + 1, col: pos.col }, false);
      else if (move === "right") moveTo(tabPos(pos, dims, false), false);
      else if (move === "left") moveTo(tabPos(pos, dims, true), false);
    },
    [rows, columns, onEdit, focusGrid, moveTo, dims],
  );

  const startEdit = useCallback(
    (pos: CellPos, initial: string | null) => {
      const column = columns[pos.col];
      const row = rows[pos.row];
      if (!column || !row) return;
      if (!isEditableColumn(column)) {
        toast.message(column.type === "formula" ? `${column.name} calculates from its formula. Edit the formula to change it.` : `${column.name} is filled by a run. Run the column to change it.`, { id: "grid-readonly" });
        return;
      }
      if (effectiveColumnType(column) === "boolean") {
        onEdit([{ rowId: row.id, columnKey: column.key, value: row.cells[column.key] !== true }]);
        return;
      }
      setEditing({ pos, initial });
    },
    [columns, rows, onEdit],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    // An open editor keeps the browser's own text undo, so this runs only when the grid itself has focus.
    const history = historyKey(e);
    if (history) {
      e.preventDefault();
      if (history === "undo") props.onUndo();
      else props.onRedo();
      return;
    }
    if (mod && ["c", "v", "x"].includes(e.key.toLowerCase())) return; // The clipboard events handle these.
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setRange({ anchor: { row: 0, col: 0 }, focus: { row: dims.rows - 1, col: dims.cols - 1 } });
      return;
    }
    const nav = movePos(active, e.key, dims, { jump: mod, pageSize: Math.floor((scroll.height - HEADER_H) / ROW_H) - 1 });
    if (nav) {
      e.preventDefault();
      moveTo(nav, e.shiftKey);
      return;
    }
    switch (e.key) {
      case "Tab": {
        const next = tabPos(active, dims, e.shiftKey);
        // At the first or last cell Tab leaves the grid, so the keyboard is never trapped.
        if (next.row === active.row && next.col === active.col) return;
        e.preventDefault();
        moveTo(next, false);
        return;
      }
      case "Enter":
        e.preventDefault();
        if (e.altKey && activeRow && activeColumn) onOpenDetails({ row: activeRow, column: activeColumn });
        else if (mod && activeRow && activeColumn && props.canRunCell?.(activeColumn)) props.onRunCell?.({ row: activeRow, column: activeColumn });
        else startEdit(active, null);
        return;
      case "F2":
        e.preventDefault();
        startEdit(active, null);
        return;
      case " ":
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Space selects the row of the active cell.
          const next = toggleRow({ ids: new Set(), anchor: null }, rowIds, active.row);
          onSelection({ ids: new Set([...selection.ids, ...next.ids]), anchor: active.row });
        } else startEdit(active, null);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        clearRange();
        return;
      case "Escape":
        if (selection.ids.size > 0) onSelection({ ids: new Set(), anchor: null });
        return;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(active, e.key);
    }
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copyRange());
  };
  const onCut = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copyRange());
    clearRange();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const route = routePaste(parseClipboard(text), bounds, { rows, columns, total, keepsOrder: props.keepsOrder });
    if (route.kind === "refuse") return void toast.error(route.message);
    if (route.kind === "block") return props.onPasteBlock(route.request);
    const plan = route.plan;
    if (plan.updates.length > 0) onEdit(plan.updates);
    if (plan.skippedRunner > 0) toast.message(skippedCellsText(plan.skippedRunner, plan.skippedFormula));
    else if (plan.clipped) toast.message("Some pasted cells fell outside the loaded rows and were skipped.");
  };

  // A touch or pen drag keeps its pointer on the fill handle and fires no mouseenter, so it finds the row under the finger.
  const trackFill = useCallback(() => {
    const move = (ev: PointerEvent) => {
      const drag = fill.current;
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[role="gridcell"]');
      if (!drag || !cell || !scroller.current?.contains(cell)) return;
      const r = Number(/^cell-(\d+)-/.exec(cell.id)?.[1]);
      if (Number.isInteger(r)) setFillTo(Math.max(r, drag.source.r1));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);

  // The newest rows and columns for the pointerup handler, which is registered once.
  const latest = useRef({ rows, columns, onEdit, fillTo });
  useEffect(() => {
    latest.current = { rows, columns, onEdit, fillTo };
  });
  useEffect(() => {
    const up = () => {
      dragging.current = false;
      const drag = fill.current;
      if (!drag) return;
      fill.current = null;
      const reached = latest.current.fillTo;
      setFillTo(null);
      if (reached === null || reached <= drag.source.r1) return;
      const plan = planFill(drag.source, reached, latest.current.rows, latest.current.columns);
      if (plan.updates.length > 0) latest.current.onEdit(plan.updates);
      if (plan.skippedRunner > 0) toast.message(skippedCellsText(plan.skippedRunner, plan.skippedFormula));
      setRange({ anchor: { row: drag.source.r0, col: drag.source.c0 }, focus: { row: Math.min(reached, latest.current.rows.length - 1), col: drag.source.c1 } });
    };
    // pointerup ends a mouse, touch or pen drag; the fill handle cancels the compatibility mouseup.
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const toggleOne = (index: number, shift: boolean) => onSelection(toggleRow(selection, rowIds, index, { range: shift }));
  const head = headerState(selection, rowIds);

  const activeId = win.start <= active.row && active.row < win.end && rows[active.row] ? `cell-${active.row}-${active.col}` : undefined;

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={props.label}
      aria-rowcount={total + 1}
      aria-colcount={columns.length + 1}
      aria-multiselectable
      aria-activedescendant={activeId}
      tabIndex={0}
      className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-background focus-ring"
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setScroll((s) => (s.top === top ? s : { ...s, top }));
      }}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
    >
      <div style={{ width: GUTTER_W + offsets.total, minWidth: "100%" }}>
        <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b bg-muted/80 backdrop-blur" style={{ height: HEADER_H }}>
          <div role="columnheader" aria-colindex={1} className="sticky left-0 z-30 flex shrink-0 items-center gap-2 border-r bg-muted px-2" style={{ width: GUTTER_W }}>
            <Checkbox
              aria-label="Select all loaded rows"
              checked={head === "all"}
              indeterminate={head === "some"}
              onCheckedChange={(checked) => onSelection(checked ? { ids: new Set(rowIds), anchor: null } : { ids: new Set(), anchor: null })}
            />
            <span className="text-xs text-muted-foreground">#</span>
          </div>
          {columns.map((column, c) => {
            const sort = sorts.get(column.key) ?? null;
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-colindex={c + 2}
                aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"}
                className={cn("relative flex shrink-0 items-center gap-1 border-r px-2 text-xs font-medium", c < pinnedCount && "sticky z-30 bg-muted", c === pinnedCount - 1 && PIN_EDGE)}
                style={{ width: widthOf(column), left: c < pinnedCount ? GUTTER_W + offsets.left[c] : undefined }}
              >
                <span className="truncate" title={`${column.name} (${typeLabel(column.type)})`}>
                  {column.name}
                </span>
                <span className="min-w-0 shrink-[10] truncate text-[10px] font-normal text-muted-foreground">{typeLabel(column.type)}</span>
                {props.coverage?.[column.key] !== undefined && (
                  <span className="min-w-0 shrink-[10] truncate text-[10px] font-normal text-muted-foreground tabular-nums" title={`Filled in ${props.coverage[column.key]}% of rows, as of load`}>
                    {props.coverage[column.key]}%
                  </span>
                )}
                {sort === "asc" && <ArrowUpIcon className="size-3 shrink-0" aria-hidden />}
                {sort === "desc" && <ArrowDownIcon className="size-3 shrink-0" aria-hidden />}
                <span className="ml-auto" />
                <ColumnMenu column={column} index={c} count={columns.length} sort={sort} pinned={pinnedKeys.includes(column.key)} pinCount={pinnedKeys.length} summary={summaries.get(column.key)} onAction={props.onColumnAction} />
                <ResizeHandle label={`Resize ${column.name}`} width={widthOf(column)} onResize={(w) => setWidths((s) => ({ ...s, [column.key]: w }))} />
              </div>
            );
          })}
        </div>

        <div style={{ height: win.totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${win.offsetTop}px)` }}>
            {rows.slice(win.start, win.end).map((row, i) => {
              const r = win.start + i;
              const selected = selection.ids.has(row.id);
              return (
                <div key={row.id} role="row" aria-rowindex={r + 2} aria-selected={selected} className={cn("flex border-b", selected && "bg-primary/5")} style={{ height: ROW_H }}>
                  <div
                    role="rowheader"
                    aria-colindex={1}
                    className={cn("sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r px-2 text-xs text-muted-foreground", selected ? "bg-accent" : "bg-background")}
                    style={{ width: GUTTER_W }}
                  >
                    <Checkbox aria-label={`Select row ${r + 1}`} checked={selected} onCheckedChange={() => {}} onClick={(e) => toggleOne(r, e.shiftKey)} />
                    <span className="tabular-nums">{r + 1}</span>
                  </div>
                  {columns.map((column, c) => {
                    const isActive = r === active.row && c === active.col;
                    const isEditing = editing !== null && editing.pos.row === r && editing.pos.col === c;
                    return (
                      <GridCell
                        key={column.id}
                        id={`cell-${r}-${c}`}
                        row={row}
                        column={column}
                        colIndex={c}
                        width={widthOf(column)}
                        stickyLeft={c < pinnedCount ? GUTTER_W + offsets.left[c] : undefined}
                        edge={c === pinnedCount - 1}
                        active={isActive}
                        inRange={inBounds(bounds, { row: r, col: c }) && !(bounds.r0 === bounds.r1 && bounds.c0 === bounds.c1)}
                        editing={isEditing ? editing : null}
                        onMouseDown={(e) => {
                          if (e.button !== 0 || isEditing) return;
                          dragging.current = true;
                          setEditing(null);
                          moveTo({ row: r, col: c }, e.shiftKey);
                          focusGrid();
                        }}
                        onMouseEnter={() => {
                          if (fill.current) setFillTo(Math.max(r, fill.current.source.r1));
                          else if (dragging.current) setRange((cur) => extendRange(cur, { row: r, col: c }));
                        }}
                        fillHandle={r === bounds.r1 && c === bounds.c1 && !isEditing && fillTo === null}
                        inFill={fillTo !== null && r > bounds.r1 && r <= fillTo && c >= bounds.c0 && c <= bounds.c1}
                        onFillStart={(pointerType) => {
                          fill.current = { source: bounds };
                          setFillTo(bounds.r1);
                          if (pointerType !== "mouse") trackFill();
                        }}
                        onDoubleClick={() => startEdit({ row: r, col: c }, null)}
                        onCommit={(value, move) => commit({ row: r, col: c }, value, move)}
                        onCancel={() => {
                          setEditing(null);
                          focusGrid();
                        }}
                        onToggle={() => onEdit([{ rowId: row.id, columnKey: column.key, value: row.cells[column.key] !== true }])}
                        onDetails={() => onOpenDetails({ row, column })}
                        onRun={props.onRunCell && props.canRunCell?.(column) ? () => props.onRunCell?.({ row, column }) : undefined}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {props.empty && <div className="sticky left-0 max-w-2xl px-6">{props.empty}</div>}
      </div>
    </div>
  );
}

const MIN_COL_W = 60;
const MAX_COL_W = 640;

/** Drags a column's right edge, or with focus the arrow keys resize it by 10px (Shift for 50px). */
function ResizeHandle({ label, width, onResize }: { label: string; width: number; onResize: (width: number) => void }) {
  const clamp = (w: number) => Math.min(MAX_COL_W, Math.max(MIN_COL_W, w));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={MIN_COL_W}
      aria-valuemax={MAX_COL_W}
      tabIndex={0}
      className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/40 focus-visible:bg-primary/40 focus-ring"
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10;
        const next = e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? MIN_COL_W : e.key === "End" ? MAX_COL_W : null;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        onResize(clamp(next));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const move = (ev: PointerEvent) => onResize(clamp(width + ev.clientX - startX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
    />
  );
}

interface CellProps {
  id: string;
  row: GridRow;
  column: GridColumn;
  colIndex: number;
  width: number;
  /** Set for a pinned column: its left edge, so it stays in view. */
  stickyLeft?: number;
  /** The last pinned column draws the divider. */
  edge?: boolean;
  active: boolean;
  inRange: boolean;
  editing: Editing | null;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onDoubleClick: () => void;
  onCommit: (value: string | null, move: CommitMove) => void;
  onCancel: () => void;
  onToggle: () => void;
  onDetails: () => void;
  /** Set when the cell has a run of its own. The active cell shows a button for touch and pointer use. */
  onRun?: () => void;
  /** The corner cell of the selection shows the fill handle. */
  fillHandle?: boolean;
  /** The cell is in the area a fill drag would write. */
  inFill?: boolean;
  /** Starts a fill drag from the handle, with the pointer type that pressed it. */
  onFillStart?: (pointerType: string) => void;
}

const GridCell = memo(function GridCell(p: CellProps) {
  const { row, column, active, editing } = p;
  const value = row.cells[column.key];
  const status = cellStatus(row, column.key);
  // An enrichment cell that never ran because the row lacks an input says so, instead of looking like one not run yet.
  const hint = status.state === "idle" && (value === null || value === undefined || value === "") ? missingInputHint(column, row.cells) : null;
  const readOnly = !isEditableColumn(column);
  const type = effectiveColumnType(column);
  return (
    <div
      id={p.id}
      role="gridcell"
      aria-colindex={p.colIndex + 2}
      aria-selected={active || p.inRange}
      aria-readonly={readOnly || undefined}
      aria-label={`${column.name}: ${displayValue(value, column) || hint?.text.toLowerCase() || "empty"}`}
      className={cn(
        "group/cell relative flex shrink-0 items-center overflow-hidden border-r text-sm select-none",
        type === "number" || type === "currency" ? "justify-end" : "",
        p.inRange && "bg-primary/10",
        p.inFill && "bg-primary/10 ring-1 ring-primary/40 ring-inset",
        active && "z-[5] ring-2 ring-primary ring-inset",
        readOnly && !p.inRange && "bg-muted/30",
        p.stickyLeft !== undefined && ["sticky z-[6]", readOnly ? "bg-muted" : p.inRange ? "bg-accent" : "bg-background", p.edge && PIN_EDGE],
      )}
      style={{ width: p.width, left: p.stickyLeft }}
      onMouseDown={p.onMouseDown}
      onMouseEnter={p.onMouseEnter}
      onDoubleClick={p.onDoubleClick}
    >
      {editing ? (
        <div className="absolute inset-0 z-10 bg-background ring-2 ring-primary ring-inset">
          <CellEditor column={column} value={value} initial={editing.initial} label={`Edit ${column.name}`} onCommit={p.onCommit} onCancel={p.onCancel} />
        </div>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-1 px-2">
          <CellContent value={value} column={column} onToggle={p.onToggle} />
          {hint && (
            <span className="truncate text-xs text-muted-foreground" title={hint.title}>
              {hint.text}
            </span>
          )}
          {status.state === "running" && <Loader2Icon className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />}
          {status.state === "waiting" && (
            <span className="ml-auto shrink-0" title={status.message}>
              <Clock3Icon className="size-3.5 text-muted-foreground" aria-label={`Waiting: ${status.message}`} />
            </span>
          )}
          {status.state === "miss" && (
            <span className="ml-auto shrink-0" title={status.message}>
              <CircleDashedIcon className="size-3.5 text-muted-foreground" aria-label={status.message} />
            </span>
          )}
          {status.state === "skipped" && (
            <span className="ml-auto shrink-0" title={status.message}>
              <AlertCircleIcon className="size-3.5 text-warning" aria-label={status.message} />
            </span>
          )}
          {status.state === "error" && (
            <span className="ml-auto shrink-0" title={status.message}>
              <AlertCircleIcon className="size-3.5 text-destructive" aria-label={status.message} />
            </span>
          )}
          {status.state === "stale" && (
            <span className="ml-auto shrink-0" title={status.message}>
              <RefreshCwIcon className="size-3.5 text-warning" aria-label={`Stale: ${status.message}`} />
            </span>
          )}
          {active && p.onRun && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Run this cell"
              title="Run this cell (Ctrl or Cmd+Enter)"
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground sm:size-5"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={p.onRun}
            >
              <PlayIcon className="size-3" />
            </button>
          )}
          {active && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Open cell details"
              className={cn("shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground", !p.onRun && "ml-auto")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={p.onDetails}
            >
              <ExpandIcon className="size-3" />
            </button>
          )}
        </div>
      )}
      {p.fillHandle && !editing && (
        <div
          role="presentation"
          data-fill-handle
          title="Drag down to copy"
          className="absolute right-0 bottom-0 z-10 size-2.5 cursor-crosshair touch-none border border-background bg-primary pointer-coarse:size-4"
          onPointerDown={(e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            p.onFillStart?.(e.pointerType);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
});

function CellContent({ value, column, onToggle }: { value: unknown; column: GridColumn; onToggle: () => void }) {
  const type = effectiveColumnType(column);
  if (value === null || value === undefined || value === "") return null;
  const text = displayValue(value, column);
  if (type === "boolean") {
    return (
      <button
        type="button"
        tabIndex={-1}
        role="checkbox"
        aria-checked={value === true}
        aria-label={column.name}
        disabled={!isEditableColumn(column)}
        className={cn("flex size-4 items-center justify-center rounded border", value === true ? "border-primary bg-primary text-primary-foreground" : "border-input")}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onToggle}
      >
        {value === true && <span aria-hidden className="text-[10px] leading-none">✓</span>}
      </button>
    );
  }
  if (type === "multiselect" && Array.isArray(value)) {
    return (
      <span className="flex min-w-0 gap-1 overflow-hidden">
        {value.map((v, i) => (
          <span key={i} className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs">
            {String(v)}
          </span>
        ))}
      </span>
    );
  }
  if (type === "select") {
    const label = selectOptions(column).find((o) => o.value === value)?.label ?? text;
    return <span className="truncate rounded bg-secondary px-1.5 py-0.5 text-xs">{label}</span>;
  }
  if ((type === "url" || type === "email") && typeof value === "string") {
    const href = type === "email" ? `mailto:${value}` : /^https?:\/\//i.test(value) ? value : null;
    if (href)
      return (
        <a href={href} target={type === "url" ? "_blank" : undefined} rel="noreferrer noopener" tabIndex={-1} title="Ctrl or Cmd and click to open" className="truncate text-primary underline-offset-2 hover:underline" onMouseDown={(e) => e.preventDefault()} onClick={(e) => !(e.metaKey || e.ctrlKey) && e.preventDefault()}>
          {text}
        </a>
      );
  }
  return <span className={cn("truncate", type === "number" || type === "currency" ? "tabular-nums" : "")}>{text}</span>;
}
