"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import type { TableView } from "@/contexts/grid/domain/view-query";
import { gridRequest, gridUrl } from "./client";
import { addPending, applyConflictRows, buildBatches, cellId, clearPending, conflictItems, mergeRows, overlayPending, splitByRows, type ConflictItem, type PendingMap } from "../edit/optimistic";
import type { CellEditInput, ChangesPage, GridColumn, GridRow, GridTable, JobCounts, RowConflict, TablePage } from "./types";
import { canRedo, canUndo, columnsInvalidate, complete, discardCells, drop, EMPTY_STACK, nextAction, record, restoreUpdates, settleAfter, type Direction, type UndoCell, type UndoStack, type WrittenCell } from "../edit/undo-stack";
import type { BlockPasteRequest } from "../edit/paste";
import { keepsTableOrder } from "../view/view";
import { countOf, formatCount } from "@/shared/format-number";

const PAGE = 200;
/** The most rows one table request returns. */
const KEEP_CAP = GRID_LIMITS.pageSize;
const POLL_IDLE_MS = 5_000;
const POLL_BUSY_MS = 1_500;
/** Most changes pages one poll follows. The cursor keeps its place, so the next poll carries on. */
const MAX_CHANGE_PAGES = 20;

/** What a cells request answers besides the rows. */
interface CellsResponse {
  rows: GridRow[];
  skippedByCap?: number;
  applied?: WrittenCell[];
  skipped?: Array<{ rowId: string; columnKey: string; current: unknown }>;
}

/** Column key to the type a cell is filtered as, for the view rules that depend on it. */
const typesOf = (columns: readonly GridColumn[]) => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const));

let actionCounter = 0;
/** An id for one undo step. `crypto.randomUUID` is missing outside secure contexts, so a counter backs it. */
const newActionId = () => `a${Date.now().toString(36)}-${(actionCounter += 1)}`;

/** What the paste route answers. */
interface PasteResponse {
  rows: GridRow[];
  applied: Array<{ rowId: string; columnKey: string; before: unknown; value: unknown }>;
  addedRows: number;
  createdColumns: GridColumn[];
  skippedRunner: number;
  skippedFormula?: number;
  invalid: Array<{ rowIndex: number; columnKey: string; error: string }>;
  invalidCount: number;
}

export interface PasteOutcome {
  cells: number;
  addedRows: number;
  addedColumns: number;
  skippedRunner: number;
  skippedFormula: number;
  invalidCount: number;
}

export interface ConflictState {
  items: ConflictItem[];
}

export interface GridTableState {
  status: "loading" | "ready" | "error";
  error: string | null;
  table: GridTable | null;
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  unfilteredTotal: number;
  loadedCount: number;
  activeJobs: number;
  jobs: JobCounts | null;
  view: TableView;
  coverage: Record<string, number>;
  search: string;
  stale: boolean;
  saving: boolean;
  conflict: ConflictState | null;
  setSearch: (value: string) => void;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  edit: (edits: CellEditInput[]) => void;
  /** Undoes or redoes the latest edit. Cells someone else changed since are left alone. */
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Pastes a block through the server: rows after the anchor in table order, new rows and columns as needed. One undo step. */
  pasteBlock: (request: BlockPasteRequest) => Promise<PasteOutcome | null>;
  canUndo: boolean;
  canRedo: boolean;
  resolveConflict: (choice: "retry" | "discard") => void;
  /** Saves the member's own view. */
  saveView: (view: TableView) => Promise<boolean>;
  /** True when the member has a view of their own on top of the table's default. */
  personalView: boolean;
  canEditDefault: boolean;
  /** Drops the member's own view. */
  resetView: () => Promise<boolean>;
  /** Owners and admins: the view on screen becomes the default for everyone. */
  saveDefaultView: () => Promise<boolean>;
  setTable: (patch: Partial<GridTable>) => void;
  refreshJobs: () => Promise<void>;
}

/** Loads one table, keeps it fresh by polling the changes feed, and applies cell edits optimistically. */
export function useGridTable(tableId: string): GridTableState {
  const [status, setStatus] = useState<GridTableState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [table, setTableState] = useState<GridTable | null>(null);
  const [columns, setColumns] = useState<GridColumn[]>([]);
  const [serverRows, setServerRows] = useState<GridRow[]>([]);
  const [pending, setPending] = useState<PendingMap>(new Map());
  const [total, setTotal] = useState(0);
  const [unfilteredTotal, setUnfilteredTotal] = useState(0);
  const [activeJobs, setActiveJobs] = useState(0);
  const [jobs, setJobs] = useState<JobCounts | null>(null);
  const [view, setView] = useState<TableView>({});
  const [personalView, setPersonalView] = useState(false);
  const [canEditDefault, setCanEditDefault] = useState(false);
  const [coverage, setCoverage] = useState<Record<string, number>>({});
  const [search, setSearchState] = useState("");
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });

  const rowsRef = useRef<GridRow[]>([]);
  const pendingRef = useRef<PendingMap>(new Map());
  const cursorRef = useRef("0");
  const totalsRef = useRef({ total: 0, unfiltered: 0 });
  const viewRef = useRef<TableView>({});
  const searchRef = useRef("");
  const loadToken = useRef(0);
  const flushing = useRef(false);
  const conflictRef = useRef<ConflictState | null>(null);
  const loadingMore = useRef(false);
  const activeRef = useRef(0);
  const flushPromise = useRef<Promise<void> | null>(null);
  const stackRef = useRef<UndoStack>(EMPTY_STACK);
  const columnsRef = useRef<GridColumn[]>([]);
  const historyBusy = useRef(false);

  const putRows = useCallback((rows: GridRow[]) => {
    rowsRef.current = rows;
    setServerRows(rows);
  }, []);
  const putPending = useCallback((next: PendingMap) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const putConflict = useCallback((next: ConflictState | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const putStack = useCallback((next: UndoStack) => {
    stackRef.current = next;
    setHistory((h) => {
      const flags = { undo: canUndo(next), redo: canRedo(next) };
      return h.undo === flags.undo && h.redo === flags.redo ? h : flags;
    });
  }, []);

  /** `coverage` false skips the fill-rate scan, for a reload that only follows the search box. */
  const load = useCallback(async (options: { coverage: boolean; keep?: number }) => {
    const token = ++loadToken.current;
    // `keep` asks for at least that many rows (one request, at most the server's page cap), so a reload does not
    // shorten the grid under a person who scrolled down: the browser would clamp the scroll position to the new end.
    const params = new URLSearchParams({ limit: String(Math.min(KEEP_CAP, Math.max(PAGE, options.keep ?? 0))) });
    if (!options.coverage) params.set("coverage", "0");
    if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
    const res = await gridRequest<TablePage>(`${gridUrl.table(tableId)}?${params}`, "GET");
    if (token !== loadToken.current) return;
    if (!res.ok || !res.data) {
      setError(res.error);
      setStatus((s) => (s === "ready" ? s : "error"));
      if (res.status !== 0) toast.error(res.error ?? "Could not load the table.");
      return;
    }
    const page = res.data;
    putRows(page.rows);
    // A deleted column or a changed type makes the recorded values wrong, so the history starts over.
    if (columnsInvalidate(columnsRef.current, page.columns)) putStack(EMPTY_STACK);
    columnsRef.current = page.columns;
    setColumns(page.columns);
    setTableState(page.table);
    setTotal(page.total);
    setUnfilteredTotal(page.unfilteredTotal);
    totalsRef.current = { total: page.total, unfiltered: page.unfilteredTotal };
    cursorRef.current = page.cursor;
    setActiveJobs(page.activeJobs);
    activeRef.current = page.activeJobs;
    setView(page.view ?? {});
    viewRef.current = page.view ?? {};
    setPersonalView(page.personalView === true);
    setCanEditDefault(page.canEditDefault === true);
    if (options.coverage) setCoverage(page.coverage ?? {});
    setStale(false);
    setError(null);
    setStatus("ready");
  }, [tableId, putRows, putStack]);

  const reload = useCallback(() => load({ coverage: true }), [load]);

  useEffect(() => {
    loadToken.current += 1;
    // The workspace is keyed by table id, so state starts empty here. The load runs from a timer so the
    // effect body itself sets no state.
    const handle = setTimeout(() => void reload(), 0);
    return () => {
      clearTimeout(handle);
      loadToken.current += 1;
    };
  }, [tableId, reload]);

  const setSearch = useCallback(
    (value: string) => {
      setSearchState(value);
      searchRef.current = value;
    },
    [],
  );

  // Search runs after a pause in typing.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) {
      firstSearch.current = false;
      return;
    }
    const handle = setTimeout(() => void load({ coverage: false }), 350);
    return () => clearTimeout(handle);
  }, [search, load]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current) return;
    const have = rowsRef.current.length;
    if (have >= totalsRef.current.total) return;
    loadingMore.current = true;
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(have) });
      if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
      const res = await gridRequest<TablePage>(`${gridUrl.table(tableId)}?${params}`, "GET");
      if (!res.ok || !res.data) return;
      const known = new Set(rowsRef.current.map((r) => r.id));
      const fresh = res.data.rows.filter((r) => !known.has(r.id));
      if (fresh.length > 0) putRows([...rowsRef.current, ...fresh]);
    } finally {
      loadingMore.current = false;
    }
  }, [tableId, putRows]);

  // Polling: the changes feed brings in enrichment results and other people's edits.
  useEffect(() => {
    if (status !== "ready") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        // A busy table can have more changes than one page. Follow hasMore, with a cap so one poll cannot run away.
        for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
          const res = await gridRequest<ChangesPage>(`${gridUrl.sub(tableId, "changes")}?cursor=${encodeURIComponent(cursorRef.current)}`, "GET");
          if (stopped) return;
          if (!(res.ok && res.data)) break;
          const data = res.data;
          cursorRef.current = data.cursor;
          setActiveJobs(data.activeJobs);
          activeRef.current = data.activeJobs;
          if (data.total < totalsRef.current.unfiltered) {
            await reload();
            break;
          }
          const complete = rowsRef.current.length >= totalsRef.current.total;
          const canAppend = complete && keepsTableOrder(viewRef.current, searchRef.current, typesOf(columnsRef.current));
          const merged = mergeRows(rowsRef.current, data.rows, { canAppend });
          if (merged.changed) putRows(merged.rows);
          if (merged.unplaced > 0 && data.total > totalsRef.current.unfiltered) setStale(true);
          if (data.total !== totalsRef.current.unfiltered) {
            const added = data.total - totalsRef.current.unfiltered;
            totalsRef.current = { total: canAppend ? totalsRef.current.total + added : totalsRef.current.total, unfiltered: data.total };
            setUnfilteredTotal(data.total);
            setTotal(totalsRef.current.total);
          }
          if (!data.hasMore) break;
        }
      }
      timer = setTimeout(tick, activeRef.current > 0 ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    timer = setTimeout(tick, POLL_BUSY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status, tableId, reload, putRows]);

  const refreshJobs = useCallback(async () => {
    const res = await gridRequest<JobCounts>(gridUrl.sub(tableId, "run"), "GET");
    if (res.ok && res.data) setJobs(res.data);
  }, [tableId]);

  // Job counts for the progress bar, only while something is running.
  useEffect(() => {
    if (status !== "ready") return;
    const first = setTimeout(() => void refreshJobs(), 0);
    const handle = activeJobs > 0 ? setInterval(() => void refreshJobs(), 2_000) : undefined;
    return () => {
      clearTimeout(first);
      if (handle) clearInterval(handle);
    };
  }, [status, activeJobs, refreshJobs]);

  // The header's fill rates are counted at load. When a run ends, count them again, so a column it just filled does
  // not read 0%.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (activeJobs > 0) {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    const handle = setTimeout(() => void load({ coverage: true, keep: rowsRef.current.length }), 0);
    return () => clearTimeout(handle);
  }, [activeJobs, load]);

  /** Takes cells out of the undo steps they belong to, for edits that will never be saved. */
  const forgetEdits = useCallback(
    (edits: Iterable<{ rowId: string; columnKey: string; actionId?: string }>) => {
      let stack = stackRef.current;
      for (const e of edits) if (e.actionId) stack = discardCells(stack, e.actionId, [e]);
      if (stack !== stackRef.current) putStack(stack);
    },
    [putStack],
  );

  const flush = useCallback((): Promise<void> => {
    if (flushing.current) return flushPromise.current ?? Promise.resolve();
    flushing.current = true;
    setSaving(true);
    const run = (async () => {
      try {
        while (pendingRef.current.size > 0 && !conflictRef.current) {
          const snapshot = new Map(pendingRef.current);
          // A large paste goes out in several requests, each within the server's limits.
          const batch = buildBatches(snapshot, rowsRef.current)[0];
          const res = await gridRequest<CellsResponse>(gridUrl.sub(tableId, "cells"), "PATCH", { updates: batch.updates });
          if (res.ok && res.data) {
            if (res.data.skippedByCap) toast.warning(`${formatCount(res.data.skippedByCap)} ${res.data.skippedByCap === 1 ? "cell was" : "cells were"} not run automatically because this change went over the auto-run limit. Run the column to fill ${res.data.skippedByCap === 1 ? "it" : "them"}.`);
            const merged = mergeRows(rowsRef.current, res.data.rows, { canAppend: false });
            putRows(merged.rows);
            // The server coerces what it stores ("42" becomes 42); undo must expect that value.
            const byAction = new Map<string, WrittenCell[]>();
            for (const w of res.data.applied ?? []) {
              const id = snapshot.get(cellId(w.rowId, w.columnKey))?.actionId;
              if (id) byAction.set(id, [...(byAction.get(id) ?? []), w]);
            }
            let stack = stackRef.current;
            for (const [id, written] of byAction) stack = settleAfter(stack, id, written);
            if (stack !== stackRef.current) putStack(stack);
            putPending(clearPending(pendingRef.current, batch.updates));
            continue;
          }
          const conflicts = res.status === 409 ? (res.failure?.conflicts as RowConflict[] | undefined) : undefined;
          if (conflicts && conflicts.length > 0) {
            putRows(applyConflictRows(rowsRef.current, conflicts));
            putConflict({ items: conflictItems(conflicts, snapshot) });
            break;
          }
          // The server refused the edit. The cells fall back to the stored values.
          toast.error(res.error ?? "Could not save the change.");
          forgetEdits(snapshot.values());
          const next = new Map(pendingRef.current);
          for (const key of snapshot.keys()) next.delete(key);
          putPending(next);
          break;
        }
      } finally {
        flushing.current = false;
        setSaving(false);
      }
    })();
    flushPromise.current = run;
    return run;
  }, [tableId, putRows, putPending, putConflict, putStack, forgetEdits]);

  const edit = useCallback(
    (edits: CellEditInput[]) => {
      if (edits.length === 0) return;
      const actionId = newActionId();
      let next: PendingMap = pendingRef.current;
      const byId = new Map(rowsRef.current.map((r) => [r.id, r]));
      const cells: UndoCell[] = [];
      for (const e of edits) {
        // What the person sees now, pending edits included, is what undo has to bring back.
        const queued = next.get(cellId(e.rowId, e.columnKey));
        const before = queued ? queued.value : (byId.get(e.rowId)?.cells[e.columnKey] ?? null);
        cells.push({ rowId: e.rowId, columnKey: e.columnKey, before, after: e.value });
        next = addPending(next, e, byId.get(e.rowId), actionId);
      }
      putStack(record(stackRef.current, actionId, cells));
      putPending(next);
      void Promise.resolve().then(flush);
    },
    [flush, putPending, putStack],
  );

  const resolveConflict = useCallback(
    (choice: "retry" | "discard") => {
      const state = conflictRef.current;
      if (!state) return;
      const next = new Map(pendingRef.current);
      const present = new Set(rowsRef.current.map((r) => r.id));
      const forgotten: Array<{ rowId: string; columnKey: string; actionId?: string }> = [];
      for (const item of state.items) {
        const key = cellId(item.rowId, item.columnKey);
        if (choice === "discard" || item.deleted || !present.has(item.rowId)) {
          forgotten.push({ rowId: item.rowId, columnKey: item.columnKey, actionId: next.get(key)?.actionId });
          next.delete(key);
        }
      }
      forgetEdits(forgotten);
      putPending(next);
      putConflict(null);
      void Promise.resolve().then(flush);
    },
    [flush, putPending, putConflict, forgetEdits],
  );

  /** Lets queued edits reach the server, so the next request sees them. */
  const settleSaves = useCallback(async () => {
    for (let i = 0; i < 5 && (flushing.current || (pendingRef.current.size > 0 && !conflictRef.current)); i += 1) await flush();
  }, [flush]);

  const pasteBlock = useCallback(
    async (request: BlockPasteRequest): Promise<PasteOutcome | null> => {
      await settleSaves();
      if (conflictRef.current) {
        toast.message("Resolve the edit conflict first.", { id: "grid-history" });
        return null;
      }
      const res = await gridRequest<PasteResponse>(gridUrl.sub(tableId, "paste"), "POST", request);
      if (!(res.ok && res.data)) {
        toast.error(res.error ?? "Could not paste. Try again.");
        // The table may have changed under the paste (a column removed, a row deleted): show what is stored now.
        if (res.status === 404 || res.status === 409) void reload();
        return null;
      }
      const data = res.data;
      // One undo step. The block went through one request, so its recorded values are the server's.
      putStack(record(stackRef.current, newActionId(), data.applied.map((a) => ({ rowId: a.rowId, columnKey: a.columnKey, before: a.before, after: a.value }))));
      if (data.addedRows > 0 || data.createdColumns.length > 0) {
        // Reload as many rows as the grid held, plus the new ones. A shorter list would clamp the scroll position
        // to the new end (near row 186 after 200 rows) and move the paste out of view.
        const want = rowsRef.current.length + data.addedRows;
        await load({ coverage: true, keep: want });
        for (let i = 0; i < 25 && rowsRef.current.length < Math.min(want, totalsRef.current.total); i += 1) await loadMore();
      }
      else putRows(mergeRows(rowsRef.current, data.rows, { canAppend: false }).rows);
      return { cells: data.applied.length, addedRows: data.addedRows, addedColumns: data.createdColumns.length, skippedRunner: data.skippedRunner, skippedFormula: data.skippedFormula ?? 0, invalidCount: data.invalidCount };
    },
    [settleSaves, tableId, reload, load, loadMore, putRows, putStack],
  );

  const history_ = useCallback(
    async (direction: Direction) => {
      if (historyBusy.current) return;
      historyBusy.current = true;
      try {
        // Queued edits land first, so the values this step expects are the ones the server stored.
        await settleSaves();
        if (conflictRef.current) return void toast.message("Resolve the edit conflict first.", { id: "grid-history" });
        const action = nextAction(stackRef.current, direction);
        if (!action) return;
        const written: WrittenCell[] = [];
        let skipped = 0;
        let failed: string | null = null;
        for (const part of splitByRows(restoreUpdates(action, direction))) {
          const res = await gridRequest<CellsResponse>(gridUrl.sub(tableId, "cells"), "PATCH", { updates: part, undo: true });
          if (!(res.ok && res.data)) {
            failed = res.error ?? `Could not ${direction} the change.`;
            break;
          }
          written.push(...(res.data.applied ?? []));
          skipped += res.data.skipped?.length ?? 0;
          putRows(mergeRows(rowsRef.current, res.data.rows, { canAppend: false }).rows);
        }
        if (failed) {
          toast.error(failed);
          // Nothing more can be done with a step the server refuses (a column is gone, say).
          if (written.length === 0) putStack(drop(stackRef.current, direction, action.id));
          else putStack(complete(stackRef.current, direction, action.id, written));
          return;
        }
        putStack(complete(stackRef.current, direction, action.id, written));
        const verb = direction === "undo" ? "Undid" : "Redid";
        if (skipped > 0) toast.warning(`${formatCount(skipped)} ${skipped === 1 ? "cell changed after your edit and was" : "cells changed after your edit and were"} left as ${skipped === 1 ? "it is" : "they are"}.`, { id: "grid-history" });
        else toast.message(`${verb} ${countOf(written.length, "cell")}.`, { id: "grid-history" });
      } finally {
        historyBusy.current = false;
      }
    },
    [settleSaves, tableId, putRows, putStack],
  );
  const undo = useCallback(() => history_("undo"), [history_]);
  const redo = useCallback(() => history_("redo"), [history_]);

  const saveView = useCallback(
    async (nextView: TableView) => {
      const previous = viewRef.current;
      viewRef.current = nextView;
      setView(nextView);
      const res = await gridRequest(gridUrl.view(tableId), "PUT", { view: nextView });
      if (!res.ok) {
        viewRef.current = previous;
        setView(previous);
        toast.error(res.error ?? "Could not save the view.");
        return false;
      }
      await reload();
      return true;
    },
    [tableId, reload],
  );

  const resetView = useCallback(async () => {
    const res = await gridRequest(gridUrl.view(tableId), "DELETE");
    if (!res.ok) {
      toast.error(res.error ?? "Could not reset the view.");
      return false;
    }
    await reload();
    return true;
  }, [tableId, reload]);

  const saveDefaultView = useCallback(async () => {
    const res = await gridRequest(gridUrl.table(tableId), "PATCH", { view: viewRef.current });
    if (!res.ok) {
      toast.error(res.error ?? "Could not save the default view.");
      return false;
    }
    toast.success("Saved as the default view for everyone.");
    await reload();
    return true;
  }, [tableId, reload]);

  const setTable = useCallback((patch: Partial<GridTable>) => setTableState((t) => (t ? { ...t, ...patch } : t)), []);

  const rows = useMemo(() => overlayPending(serverRows, pending), [serverRows, pending]);

  return {
    status,
    error,
    table,
    columns,
    rows,
    total,
    unfilteredTotal,
    loadedCount: serverRows.length,
    activeJobs,
    jobs,
    view,
    personalView,
    canEditDefault,
    resetView,
    saveDefaultView,
    coverage,
    search,
    stale,
    saving,
    conflict,
    setSearch,
    reload,
    loadMore,
    edit,
    undo,
    redo,
    pasteBlock,
    canUndo: history.undo,
    canRedo: history.redo,
    resolveConflict,
    saveView,
    setTable,
    refreshJobs,
  };
}
