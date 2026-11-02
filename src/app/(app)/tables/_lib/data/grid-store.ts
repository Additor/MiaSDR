import { gridUrl, type GridResponse } from "./client";
import { RESOLVE_CONFLICT_FIRST } from "./cell-request";
import type { CellEditInput, GridRow, RowConflict } from "./types";
import { addPending, applyConflictRows, buildBatches, cellId, clearPending, conflictItems, dropPendingRows, mergeRows, sendablePending, splitByRows, type ConflictItem, type PendingMap } from "../edit/optimistic";
import { DELETE_BATCH } from "../edit/delete-rows";
import { canRedo, canUndo, complete, discardCells, discardRows, drop, EMPTY_STACK, nextAction, record, restoreUpdates, settleAfter, type Direction, type UndoCell, type UndoStack, type WrittenCell } from "../edit/undo-stack";
import { countOf, formatCount } from "@/shared/format-number";

/** What a cells request answers besides the rows. */
interface CellsResponse {
  rows: GridRow[];
  skippedByCap?: number;
  applied?: WrittenCell[];
  skipped?: Array<{ rowId: string; columnKey: string; current: unknown }>;
}

export interface ConflictState {
  items: ConflictItem[];
}

/** How a row delete went: rows the server removed, and where the batches stopped when one failed. */
export interface DeleteRowsOutcome {
  deleted: number;
  /** Index into the requested ids of the first batch that failed, or -1. */
  failedFrom: number;
  error: string | null;
}

/** What a screen shows of the store. A new object only when one of these changed. */
export interface GridSnapshot {
  rows: GridRow[];
  pending: PendingMap;
  conflict: ConflictState | null;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface GridStoreDeps {
  tableId: string;
  request: <T = unknown>(url: string, method: "PATCH" | "DELETE", body?: unknown) => Promise<GridResponse<T>>;
  toast: {
    error: (message: string) => void;
    warning: (message: string, options?: { id: string }) => void;
    message: (message: string, options?: { id: string }) => void;
  };
}

export type GridStore = ReturnType<typeof createGridStore>;

let actionCounter = 0;
/** An id for one undo step. `crypto.randomUUID` is missing outside secure contexts, so a counter backs it. */
const newActionId = () => `a${Date.now().toString(36)}-${(actionCounter += 1)}`;

/**
 * The rows of one open table and the edits on their way to the server. The order of those requests decides what the
 * server stores, so it lives here, away from React, where a test can hold an answer back. `useGridTable` renders the
 * snapshot, and loads and polls into `putRows`.
 */
export function createGridStore({ tableId, request, toast }: GridStoreDeps) {
  let snapshot: GridSnapshot = { rows: [], pending: new Map(), conflict: null, saving: false, canUndo: false, canRedo: false };
  let stack: UndoStack = EMPTY_STACK;
  /** Rows a delete is removing. Their queued edits stay on screen but no save sends them. */
  let deleting: ReadonlySet<string> = new Set();
  let flushing = false;
  let flushPromise: Promise<void> | null = null;
  let historyBusy = false;
  const listeners = new Set<() => void>();
  const cellsUrl = gridUrl.sub(tableId, "cells");

  const publish = (patch: Partial<GridSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const putRows = (rows: GridRow[]) => publish({ rows });
  const putPending = (pending: PendingMap) => publish({ pending });

  const putStack = (next: UndoStack) => {
    stack = next;
    const flags = { canUndo: canUndo(next), canRedo: canRedo(next) };
    if (flags.canUndo !== snapshot.canUndo || flags.canRedo !== snapshot.canRedo) publish(flags);
  };

  /** Takes cells out of the undo steps they belong to, for edits that will never be saved. */
  const forgetEdits = (edits: Iterable<{ rowId: string; columnKey: string; actionId?: string }>) => {
    let next = stack;
    for (const e of edits) if (e.actionId) next = discardCells(next, e.actionId, [e]);
    if (next !== stack) putStack(next);
  };

  const sendable = () => sendablePending(snapshot.pending, deleting);

  const flush = (): Promise<void> => {
    if (flushing) return flushPromise ?? Promise.resolve();
    flushing = true;
    publish({ saving: true });
    const run = (async () => {
      try {
        while (sendable().size > 0 && !snapshot.conflict) {
          const sent = new Map(sendable());
          // A large paste goes out in several requests, each within the server's limits.
          const batch = buildBatches(sent, snapshot.rows)[0];
          const res = await request<CellsResponse>(cellsUrl, "PATCH", { updates: batch.updates });
          if (res.ok && res.data) {
            if (res.data.skippedByCap) toast.warning(`${formatCount(res.data.skippedByCap)} ${res.data.skippedByCap === 1 ? "cell was" : "cells were"} not run automatically because this change went over the auto-run limit. Run the column to fill ${res.data.skippedByCap === 1 ? "it" : "them"}.`);
            putRows(mergeRows(snapshot.rows, res.data.rows, { canAppend: false }).rows);
            // The server coerces what it stores ("42" becomes 42); undo must expect that value.
            const byAction = new Map<string, WrittenCell[]>();
            for (const w of res.data.applied ?? []) {
              const id = sent.get(cellId(w.rowId, w.columnKey))?.actionId;
              if (id) byAction.set(id, [...(byAction.get(id) ?? []), w]);
            }
            let next = stack;
            for (const [id, written] of byAction) next = settleAfter(next, id, written);
            if (next !== stack) putStack(next);
            putPending(clearPending(snapshot.pending, batch.updates));
            continue;
          }
          const conflicts = res.status === 409 ? (res.failure?.conflicts as RowConflict[] | undefined) : undefined;
          if (conflicts && conflicts.length > 0) {
            putRows(applyConflictRows(snapshot.rows, conflicts));
            publish({ conflict: { items: conflictItems(conflicts, sent) } });
            break;
          }
          // The server refused the edit. The cells fall back to the stored values.
          toast.error(res.error ?? "Could not save the change.");
          forgetEdits(sent.values());
          const next = new Map(snapshot.pending);
          for (const key of sent.keys()) next.delete(key);
          putPending(next);
          break;
        }
      } finally {
        flushing = false;
        publish({ saving: false });
      }
    })();
    flushPromise = run;
    return run;
  };

  const edit = (edits: CellEditInput[]) => {
    if (edits.length === 0) return;
    const actionId = newActionId();
    let next: PendingMap = snapshot.pending;
    const byId = new Map(snapshot.rows.map((r) => [r.id, r]));
    const cells: UndoCell[] = [];
    for (const e of edits) {
      // What the person sees now, pending edits included, is what undo has to bring back.
      const queued = next.get(cellId(e.rowId, e.columnKey));
      const before = queued ? queued.value : (byId.get(e.rowId)?.cells[e.columnKey] ?? null);
      cells.push({ rowId: e.rowId, columnKey: e.columnKey, before, after: e.value });
      next = addPending(next, e, byId.get(e.rowId), actionId);
    }
    putStack(record(stack, actionId, cells));
    putPending(next);
    void Promise.resolve().then(flush);
  };

  const resolveConflict = (choice: "retry" | "discard") => {
    const state = snapshot.conflict;
    if (!state) return;
    const next = new Map(snapshot.pending);
    const present = new Set(snapshot.rows.map((r) => r.id));
    const forgotten: Array<{ rowId: string; columnKey: string; actionId?: string }> = [];
    for (const item of state.items) {
      const key = cellId(item.rowId, item.columnKey);
      if (choice === "discard" || item.deleted || !present.has(item.rowId)) {
        forgotten.push({ rowId: item.rowId, columnKey: item.columnKey, actionId: next.get(key)?.actionId });
        next.delete(key);
      }
    }
    forgetEdits(forgotten);
    publish({ pending: next, conflict: null });
    void Promise.resolve().then(flush);
  };

  /** Lets queued edits reach the server. False when the conflict dialog holds some back. */
  const settle = async () => {
    for (let i = 0; i < 5 && (flushing || (sendable().size > 0 && !snapshot.conflict)); i += 1) await flush();
    return !snapshot.conflict;
  };

  /**
   * Runs `send` once queued edits have landed. With the conflict dialog open the held edits have not landed, so it
   * sends nothing and answers `refused`. Every request about stored cells goes through here.
   */
  const whenSettled = async <R,>(send: () => Promise<R>, refused: () => R): Promise<R> => ((await settle()) ? send() : refused());

  /** Tells the person why a gesture waits, for the gestures that answer with a toast. */
  const refusedGesture = () => void toast.message(RESOLVE_CONFLICT_FIRST, { id: "grid-history" });

  /** Drops the queued edits and undo cells of rows the server removed. */
  const forgetRows = (rowIds: readonly string[]) => {
    const dropped = dropPendingRows(snapshot.pending, rowIds);
    if (dropped.dropped.length > 0) putPending(dropped.pending);
    putStack(discardRows(stack, rowIds));
  };

  /** Drops every queued edit and undo step, for a change that removed rows the client cannot name. */
  const forgetAll = () => {
    putPending(new Map());
    putStack(EMPTY_STACK);
  };

  /** Deletes in batches, then drops queued edits and undo steps of the deleted rows. */
  const deleteRows = async (rowIds: readonly string[]): Promise<DeleteRowsOutcome> => {
    // Edits of these rows wait for the whole delete, those typed during it too: saving one could queue a paid
    // auto-run for a row about to go.
    deleting = new Set([...deleting, ...rowIds]);
    try {
      return await whenSettled(
        async () => {
          let deleted = 0;
          let failedFrom = -1;
          let error: string | null = null;
          for (let i = 0; i < rowIds.length; i += DELETE_BATCH) {
            const res = await request<{ deleted: number }>(gridUrl.sub(tableId, "rows"), "DELETE", { rowIds: rowIds.slice(i, i + DELETE_BATCH) });
            if (!res.ok) {
              failedFrom = i;
              error = res.error ?? "The server did not accept the request";
              break;
            }
            deleted += res.data?.deleted ?? 0;
          }
          // An edit queued for a deleted row would come back as a conflict, and its undo step has nothing to restore.
          forgetRows(failedFrom < 0 ? rowIds : rowIds.slice(0, failedFrom));
          return { deleted, failedFrom, error };
        },
        () => ({ deleted: 0, failedFrom: 0, error: RESOLVE_CONFLICT_FIRST }),
      );
    } finally {
      // The rows the server kept send their edits again.
      const done = new Set(rowIds);
      deleting = new Set([...deleting].filter((id) => !done.has(id)));
      void Promise.resolve().then(flush);
    }
  };

  /** One undo or redo step against the stored cells. `history` runs it once queued edits have landed. */
  const step = async (direction: Direction) => {
    const action = nextAction(stack, direction);
    if (!action) return;
    const written: WrittenCell[] = [];
    let skipped = 0;
    let failed: string | null = null;
    for (const part of splitByRows(restoreUpdates(action, direction))) {
      const res = await request<CellsResponse>(cellsUrl, "PATCH", { updates: part, undo: true });
      if (!(res.ok && res.data)) {
        failed = res.error ?? `Could not ${direction} the change.`;
        break;
      }
      written.push(...(res.data.applied ?? []));
      skipped += res.data.skipped?.length ?? 0;
      putRows(mergeRows(snapshot.rows, res.data.rows, { canAppend: false }).rows);
    }
    if (failed) {
      toast.error(failed);
      // Nothing more can be done with a step the server refuses (a column is gone, say).
      if (written.length === 0) putStack(drop(stack, direction, action.id));
      else putStack(complete(stack, direction, action.id, written));
      return;
    }
    putStack(complete(stack, direction, action.id, written));
    const verb = direction === "undo" ? "Undid" : "Redid";
    if (skipped > 0) toast.warning(`${formatCount(skipped)} ${skipped === 1 ? "cell changed after your edit and was" : "cells changed after your edit and were"} left as ${skipped === 1 ? "it is" : "they are"}.`, { id: "grid-history" });
    else toast.message(`${verb} ${countOf(written.length, "cell")}.`, { id: "grid-history" });
  };

  const history = async (direction: Direction) => {
    if (historyBusy) return;
    historyBusy = true;
    try {
      // Queued edits land first, so the values this step expects are the ones the server stored.
      await whenSettled(() => step(direction), refusedGesture);
    } finally {
      historyBusy = false;
    }
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => snapshot,
    rows: () => snapshot.rows,
    putRows,
    /** Records a change the server already applied as one undo step. */
    recordStep: (cells: UndoCell[]) => putStack(record(stack, newActionId(), cells)),
    /** Starts the undo history over, when its recorded values no longer hold. */
    resetHistory: () => putStack(EMPTY_STACK),
    edit,
    resolveConflict,
    settle,
    whenSettled,
    refusedGesture,
    forgetRows,
    forgetAll,
    deleteRows,
    undo: () => history("undo"),
    redo: () => history("redo"),
  };
}
