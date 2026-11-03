"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import type { TableView } from "@/contexts/grid/domain/view-query";
import { gridRequest, gridUrl, type GridResponse } from "./client";
import { RESOLVE_CONFLICT_FIRST, type CellRequest } from "./cell-request";
import { createGridStore, type ConflictState, type DeleteRowsOutcome } from "./grid-store";
import { mergeRows, overlayPending } from "../edit/optimistic";
import { mergeLoaded } from "../edit/merge-loaded";
import type { CellEditInput, ChangesPage, GridColumn, GridRow, GridTable, JobCounts, TablePage } from "./types";
import { columnsInvalidate } from "../edit/undo-stack";
import type { BlockPasteRequest } from "../edit/paste";
import { keepsTableOrder } from "../view/view";

const PAGE = 200;
/** The answer of a request the hook did not send because the conflict dialog is open. */
const refusedForConflict = <T>(): GridResponse<T> => ({ ok: false, status: 409, data: null, error: RESOLVE_CONFLICT_FIRST, failure: null });
/** The most rows one table request returns. */
const KEEP_CAP = GRID_LIMITS.pageSize;
const POLL_IDLE_MS = 5_000;
const POLL_BUSY_MS = 1_500;
/** Most changes pages one poll follows. The cursor keeps its place, so the next poll carries on. */
const MAX_CHANGE_PAGES = 20;

/** Column key to the type a cell is filtered as, for the view rules that depend on it. */
const typesOf = (columns: readonly GridColumn[]) => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const));

/** What the paste route answers. */
interface PasteResponse {
  rows: GridRow[];
  applied: Array<{ rowId: string; columnKey: string; before: unknown; value: unknown }>;
  addedRows: number;
  createdColumns: GridColumn[];
  skippedRunner: number;
  invalid: Array<{ rowIndex: number; columnKey: string; error: string }>;
  invalidCount: number;
}

export interface PasteOutcome {
  cells: number;
  addedRows: number;
  addedColumns: number;
  skippedRunner: number;
  invalidCount: number;
}

export type { ConflictState, DeleteRowsOutcome };

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
  /**
   * Sends a request about this table once queued edits have landed, so the server reads and writes the cells the
   * person sees. Refuses while the conflict dialog is open. Components send every table request through it
   * (`useCellRequest`); `src/architecture/grid-cell-requests.test.ts` holds them to it.
   */
  cellRequest: CellRequest;
  /** Lets queued edits land. False when the conflict dialog holds some back. */
  settle: () => Promise<boolean>;
  /*
   * Requests that write rows or cells, or read cells the person may be saving. Each lets queued edits reach
   * the server first and reloads the table after.
   */
  addRows: (count: number) => Promise<GridResponse<unknown>>;
  /** Deletes in batches, then drops queued edits and undo steps of the deleted rows. */
  deleteRows: (rowIds: readonly string[]) => Promise<DeleteRowsOutcome>;
  /** Removes the rows that repeat a value of the column, then drops their queued edits and undo steps. */
  dedupeColumn: (columnId: string) => Promise<GridResponse<{ deleted: number; rowIds: string[]; truncated: boolean }>>;
  moveColumn: (columnId: string, afterColumnId: string | null) => Promise<GridResponse<unknown>>;
  duplicateColumn: (body: Record<string, unknown>) => Promise<GridResponse<unknown>>;
  /** Queues failed cells again: one column's, or the whole table's without a key. */
  retryFailed: (columnKey?: string) => Promise<GridResponse<{ retried: number }>>;
  /** Queues the runs behind cells, such as one cell's run (`cellRunBody`). */
  runCells: <T extends { queued: number } = { queued: number }>(body: Record<string, unknown>) => Promise<GridResponse<T>>;
  addOutput: (runnerId: string, outputKey: string) => Promise<GridResponse<{ filled?: number }>>;
}

/** Loads one table, keeps it fresh by polling the changes feed, and applies cell edits optimistically. */
export function useGridTable(tableId: string): GridTableState {
  const [status, setStatus] = useState<GridTableState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [table, setTableState] = useState<GridTable | null>(null);
  const [columns, setColumns] = useState<GridColumn[]>([]);
  // The workspace is keyed by table id, so one store serves one table for the life of the hook.
  const [store] = useState(() => createGridStore({ tableId, request: gridRequest, toast }));
  const { rows: serverRows, pending, conflict, saving, canUndo, canRedo } = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
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

  const cursorRef = useRef("0");
  const totalsRef = useRef({ total: 0, unfiltered: 0 });
  const viewRef = useRef<TableView>({});
  const searchRef = useRef("");
  const loadToken = useRef(0);
  /** The `loadToken` of the last load that finished, put its rows on screen or failed. A lower `loadToken` means a load is in flight. */
  const settledToken = useRef(0);
  const loadingMore = useRef(false);
  const activeRef = useRef(0);
  const columnsRef = useRef<GridColumn[]>([]);

  /**
   * `coverage` false skips the fill-rate scan, for a reload that follows the search box. The page replaces the
   * rows through `mergeLoaded`, so a page that read a row before an edit response came back cannot lower its version.
   */
  const load = useCallback(async (options: { coverage: boolean; keep?: number }) => {
    const token = ++loadToken.current;
    // `keep` asks for at least that many rows (one request, at most the server's page cap), so a reload does not
    // shorten the grid under a person who scrolled down: the browser would clamp the scroll position to the new end.
    // It defaults to the rows loaded now. A search replaces the result set, so its load asks for the first page.
    const keep = options.keep ?? store.rows().length;
    const params = new URLSearchParams({ limit: String(Math.min(KEEP_CAP, Math.max(PAGE, keep))) });
    if (!options.coverage) params.set("coverage", "0");
    if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
    const res = await gridRequest<TablePage>(`${gridUrl.table(tableId)}?${params}`, "GET");
    if (token !== loadToken.current) return;
    settledToken.current = token;
    if (!res.ok || !res.data) {
      setError(res.error);
      setStatus((s) => (s === "ready" ? s : "error"));
      if (res.status !== 0) toast.error(res.error ?? "Could not load the table.");
      return;
    }
    const page = res.data;
    store.putRows(mergeLoaded(store.rows(), page.rows));
    // A deleted column or a changed type makes the recorded values wrong, so the history starts over.
    if (columnsInvalidate(columnsRef.current, page.columns)) store.resetHistory();
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
  }, [tableId, store]);

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
    const handle = setTimeout(() => void load({ coverage: false, keep: PAGE }), 350);
    return () => clearTimeout(handle);
  }, [search, load]);

  const loadMore = useCallback(async () => {
    // While a load is on its way, the loaded rows are not the ones its offset and search would count from.
    if (loadingMore.current || loadToken.current !== settledToken.current) return;
    const have = store.rows().length;
    if (have >= totalsRef.current.total) return;
    loadingMore.current = true;
    // A load that starts meanwhile replaces the rows this offset counted, so its answer would not line up.
    const token = loadToken.current;
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(have) });
      if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
      const res = await gridRequest<TablePage>(`${gridUrl.table(tableId)}?${params}`, "GET");
      if (token !== loadToken.current || !res.ok || !res.data) return;
      const known = new Set(store.rows().map((r) => r.id));
      const fresh = res.data.rows.filter((r) => !known.has(r.id));
      if (fresh.length > 0) store.putRows([...store.rows(), ...fresh]);
    } finally {
      loadingMore.current = false;
    }
  }, [tableId, store]);

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
          const complete = store.rows().length >= totalsRef.current.total;
          const canAppend = complete && keepsTableOrder(viewRef.current, searchRef.current, typesOf(columnsRef.current));
          const merged = mergeRows(store.rows(), data.rows, { canAppend });
          if (merged.changed) store.putRows(merged.rows);
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
  }, [status, tableId, reload, store]);

  const refreshJobs = useCallback(async () => {
    const res = await gridRequest<JobCounts>(gridUrl.sub(tableId, "run"), "GET");
    if (res.ok && res.data) setJobs(res.data);
  }, [tableId]);

  // Job counts for the progress bar, only while something is running.
  useEffect(() => {
    if (status !== "ready") return;
    const first = setTimeout(() => void refreshJobs(), 0);
    // A hidden tab skips the changes poll, so the count that keeps this running would not drop until the tab shows again.
    const handle = activeJobs > 0 ? setInterval(() => void (document.visibilityState === "visible" && refreshJobs()), 2_000) : undefined;
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
    const handle = setTimeout(() => void reload(), 0);
    return () => clearTimeout(handle);
  }, [activeJobs, reload]);

  const pasteBlock = useCallback(
    (request: BlockPasteRequest): Promise<PasteOutcome | null> => store.whenSettled(async () => {
      const res = await gridRequest<PasteResponse>(gridUrl.sub(tableId, "paste"), "POST", request);
      if (!(res.ok && res.data)) {
        toast.error(res.error ?? "Could not paste. Try again.");
        // The table may have changed under the paste (a column removed, a row deleted): show what is stored now.
        if (res.status === 404 || res.status === 409) void reload();
        return null;
      }
      const data = res.data;
      // One undo step. The block went through one request, so its recorded values are the server's.
      store.recordStep(data.applied.map((a) => ({ rowId: a.rowId, columnKey: a.columnKey, before: a.before, after: a.value })));
      if (data.addedRows > 0 || data.createdColumns.length > 0) {
        // Reload as many rows as the grid held, plus the new ones. A shorter list would clamp the scroll position
        // to the new end (near row 186 after 200 rows) and move the paste out of view.
        const want = store.rows().length + data.addedRows;
        await load({ coverage: true, keep: want });
        for (let i = 0; i < 25 && store.rows().length < Math.min(want, totalsRef.current.total); i += 1) await loadMore();
      }
      else store.putRows(mergeRows(store.rows(), data.rows, { canAppend: false }).rows);
      return { cells: data.applied.length, addedRows: data.addedRows, addedColumns: data.createdColumns.length, skippedRunner: data.skippedRunner, invalidCount: data.invalidCount };
    }, () => (store.refusedGesture(), null)),
    [store, tableId, reload, load, loadMore],
  );

  const cellRequest = useCallback<CellRequest>(
    <T,>(url: string, method: Parameters<typeof gridRequest>[1], body?: unknown) => store.whenSettled(() => gridRequest<T>(url, method, body), refusedForConflict<T>),
    [store],
  );

  /** `cellRequest` and a reload after, so the grid shows what the request changed. */
  const afterSaves = useCallback(
    <T,>(url: string, method: "POST" | "PATCH", body?: unknown): Promise<GridResponse<T>> =>
      store.whenSettled(async () => {
        const res = await gridRequest<T>(url, method, body);
        await reload();
        return res;
      }, refusedForConflict<T>),
    [store, reload],
  );

  const addRows = useCallback((count: number) => afterSaves(gridUrl.sub(tableId, "rows"), "POST", { count }), [afterSaves, tableId]);
  const moveColumn = useCallback((columnId: string, afterColumnId: string | null) => afterSaves(`${gridUrl.sub(tableId, "columns")}/${columnId}`, "PATCH", { afterColumnId }), [afterSaves, tableId]);
  const duplicateColumn = useCallback((body: Record<string, unknown>) => afterSaves(gridUrl.sub(tableId, "columns"), "POST", body), [afterSaves, tableId]);
  const retryFailed = useCallback((columnKey?: string) => afterSaves<{ retried: number }>(gridUrl.sub(tableId, "run/retry"), "POST", columnKey ? { columnKey } : {}), [afterSaves, tableId]);
  // A run reads the stored inputs, so a queued input would be left out.
  const runCells = useCallback(<T extends { queued: number } = { queued: number }>(body: Record<string, unknown>) => afterSaves<T>(gridUrl.sub(tableId, "run"), "POST", body), [afterSaves, tableId]);
  const addOutput = useCallback((runnerId: string, outputKey: string) => afterSaves<{ filled?: number }>(gridUrl.sub(tableId, "enrichments"), "PATCH", { columnId: runnerId, addOutput: outputKey }), [afterSaves, tableId]);

  const deleteRows = useCallback(
    async (rowIds: readonly string[]): Promise<DeleteRowsOutcome> => {
      try {
        return await store.deleteRows(rowIds);
      } finally {
        await reload();
      }
    },
    [store, reload],
  );

  const dedupeColumn = useCallback(
    // Dedupe compares stored values, so queued edits land first; it names the rows it removed.
    (columnId: string) =>
      store.whenSettled(async () => {
        const res = await gridRequest<{ deleted: number; rowIds: string[]; truncated: boolean }>(`${gridUrl.sub(tableId, "columns")}/${columnId}/dedupe`, "POST");
        if (res.ok && res.data) {
          // A list cut short names some of the rows. The queue was settled, so forgetting the whole table costs little.
          if (res.data.truncated) store.forgetAll();
          else store.forgetRows(res.data.rowIds);
        }
        await reload();
        return res;
      }, refusedForConflict<{ deleted: number; rowIds: string[]; truncated: boolean }>),
    [store, tableId, reload],
  );

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
    edit: store.edit,
    undo: store.undo,
    redo: store.redo,
    pasteBlock,
    canUndo,
    canRedo,
    resolveConflict: store.resolveConflict,
    saveView,
    setTable,
    refreshJobs,
    addRows,
    cellRequest,
    settle: store.settle,
    deleteRows,
    dedupeColumn,
    runCells,
    moveColumn,
    duplicateColumn,
    retryFailed,
    addOutput,
  };
}
