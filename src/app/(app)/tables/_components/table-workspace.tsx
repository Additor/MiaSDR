"use client";

import { DownloadIcon, RefreshCwIcon, PlayIcon, SendIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BulkBar } from "@/components/shell/bulk-bar";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { countOf, formatCount } from "@/shared/format-number";
import { gridUrl } from "../_lib/data/client";
import { CellRequestContext, RESOLVE_CONFLICT_FIRST } from "../_lib/data/cell-request";
import { deleteRowsReport, deleteRowsTitle } from "../_lib/edit/delete-rows";
import { emptySelection, pruneSelection, type RowSelection } from "../_lib/view/selection";
import { useGridTable } from "../_lib/data/use-grid-table";
import { cellRunBody, recalcSummary, retrySummary, runCellSource } from "../_lib/data/run-request";
import { withGridFocus } from "../_lib/edit/history-focus";
import { layoutPins, pinPhoneNotice, withPin } from "../_lib/view/pin-layout";
import { filtersNarrow, keepsTableOrder, setSort, toggleHidden, withRunFailures } from "../_lib/view/view";
import { useIsMobile } from "@/components/hooks/use-mobile";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { pasteSummary, type BlockPasteRequest } from "../_lib/edit/paste";
import type { GridColumn } from "../_lib/data/types";
import { AiDialog } from "./ai-dialog";
import { CellDrawer } from "./cell-drawer";
import { ColumnDialogs, type ColumnRequest } from "./column-dialogs";
import { duplicateColumnRequest, type ColumnAction } from "../_lib/edit/column-actions";
import { pagesToReachEnd } from "../_lib/edit/add-rows";
import { AddRowsDialog } from "./add-rows-dialog";
import { ConflictDialog } from "./conflict-dialog";
import { DataGrid, type ActiveCell } from "./data-grid";
import { EnrichStart } from "./enrich-start";
import { EnrichmentDialog } from "./enrichment-dialog";
import { TableFilterPopover, TableSortPopover } from "./view-popovers";
import { FormulaDialog } from "./formula-dialog";
import { TableImportDialog } from "./table-import-dialog";
import { PushCampaignDialog } from "./push-campaign-dialog";
import { RunDialog } from "./run-controls";
import { TableToolbar } from "./table-toolbar";
import { ViewBar } from "./view-bar";

type Open =
  | { kind: "import" }
  | { kind: "formula"; column: GridColumn | null; after?: string }
  | { kind: "enrichment"; column: GridColumn | null; after?: string; outcome?: string }
  | { kind: "ai"; column: GridColumn | null; after?: string }
  | { kind: "run"; column: GridColumn | null; firstN?: number }
  | { kind: "push"; rowIds: string[]; allRows?: boolean }
  | { kind: "details"; rowId: string; columnKey: string }
  | { kind: "deleteRows"; count: number }
  | { kind: "addRows" }
  | { kind: "column"; request: ColumnRequest };

interface Props {
  tableId: string;
  /** Hands the workbook the open table's `settle`, for a request about this table sent from outside it (duplicate). */
  onSettle?: (settle: (() => Promise<boolean>) | null) => void;
}

/** One table: toolbar, the grid and every dialog that acts on it. Remount with a new key per table. */
export function TableWorkspace({ tableId, onSettle }: Props) {
  const grid = useGridTable(tableId);
  const { settle } = grid;
  useEffect(() => {
    onSettle?.(settle);
    return () => onSettle?.(null);
  }, [onSettle, settle]);
  const [selection, setSelection] = useState<RowSelection>(emptySelection);
  const [dialog, setDialog] = useState<Open | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [reveal, setReveal] = useState<{ key: string; token: number } | null>(null);
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [busy, setBusy] = useState(false);

  const { columns, rows, view } = grid;
  const phone = useIsMobile();
  const hidden = useMemo(() => new Set(view.hiddenColumns ?? []), [view.hiddenColumns]);
  const visible = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);
  // Pinned columns lead the grid. Phone width ignores pins: a pinned column there would take the whole screen.
  const layout = useMemo(() => layoutPins(visible, view.pinnedColumns, !phone), [visible, view.pinnedColumns, phone]);
  const sorts = useMemo(() => new Map((view.sorts ?? []).map((s) => [s.columnKey, s.direction] as const)), [view.sorts]);
  const rowNumbers = useMemo(() => new Map(rows.map((r, i) => [r.id, i + 1] as const)), [rows]);
  const types = useMemo(() => new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const)), [columns]);
  const nameOf = useCallback((key: string) => columns.find((c) => c.key === key)?.name ?? key, [columns]);

  // Rows that vanished (deleted elsewhere) leave the selection once the whole table is loaded.
  // With only part of the table loaded, ids of rows that are not loaded must stay (select all matching).
  const live = useMemo(() => (rows.length >= grid.total ? pruneSelection(selection, new Set(rows.map((r) => r.id))) : selection), [selection, rows, grid.total]);
  const selectedIds = useMemo(() => [...live.ids], [live]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setFocusToken((t) => t + 1);
  }, []);

  const refocusGrid = useCallback(() => setFocusToken((t) => t + 1), []);

  const runnable = columns.some((c) => ["enrichment", "waterfall", "ai"].includes(c.type));

  function onColumnAction(column: GridColumn, action: ColumnAction) {
    const index = columns.findIndex((c) => c.id === column.id);
    switch (action.kind) {
      case "sort":
        return void grid.saveView(setSort(view, column.key, action.direction, { only: true }));
      case "hide":
        return void grid.saveView(toggleHidden(view, column.key, true));
      case "config":
        if (column.type === "formula") return setDialog({ kind: "formula", column });
        if (column.type === "ai") return setDialog({ kind: "ai", column });
        if (column.type === "enrichment" || column.type === "waterfall") return setDialog({ kind: "enrichment", column });
        return setDialog({ kind: "column", request: { column, action } });
      case "run":
        return setDialog({ kind: "run", column });
      case "retry":
        return void grid.retryFailed(column.key).then((res) => {
          if (!res.ok) toast.error(res.error ?? "Could not retry.");
          else toast.success(retrySummary(res.data?.retried ?? 0));
        });
      case "recalculate":
        return void grid.recalculate(column.id).then((res) => {
          if (!res.ok) toast.error(res.error ?? "Could not recalculate.");
          else toast.success(recalcSummary(column.name, res.data?.changedCells ?? 0));
        });
      case "move": {
        const after = action.side === "left" ? (columns[index - 2]?.id ?? null) : (columns[index + 1]?.id ?? null);
        if (action.side === "right" && !columns[index + 1]) return;
        return void grid.moveColumn(column.id, after).then((res) => {
          if (!res.ok) toast.error(res.error ?? "Could not move the column.");
        });
      }
      // Pins are part of the member's own view, so they save through the personal view layer.
      case "pin":
      case "unpin": {
        const pin = action.kind === "pin";
        const notice = pinPhoneNotice(phone, pin);
        if (notice) toast.message(notice, { id: "grid-pin" });
        return void grid.saveView(withPin(view, column.key, pin));
      }
      case "duplicate":
        return void duplicateColumn(column);
      case "runFirstN":
        return setDialog({ kind: "run", column, firstN: action.count });
      default:
        return setDialog({ kind: "column", request: { column, action } });
    }
  }

  /** Queues the one run behind a cell: the cell's own column, or the source column of an output cell, for this row only. */
  async function runCell(column: GridColumn, rowId: string) {
    const source = runCellSource(column, columns);
    if (!source) return void toast.message(`${column.name} is not an AI or enrichment column, so there is nothing to run.`, { id: "grid-run-cell" });
    const res = await grid.runCells(cellRunBody(source.key, rowId));
    if (!res.ok) return void toast.error(res.error ?? "Could not run the cell.", { id: "grid-run-cell" });
    if ((res.data?.queued ?? 0) === 0) toast.message(`Nothing to run. The inputs of ${source.name} are empty in this row.`, { id: "grid-run-cell" });
    else toast.success(`Running ${source.name} for this row.`, { id: "grid-run-cell" });
  }

  /** A "(copy)" next to the column. A data column brings its values; a formula column is recalculated by the server. */
  async function duplicateColumn(column: GridColumn) {
    const body = duplicateColumnRequest(column);
    if (!body) return void toast.message(`${column.name} is an AI or enrichment column, so it cannot be duplicated.`);
    const res = await grid.duplicateColumn(body);
    if (!res.ok) toast.error(res.error ?? "Could not duplicate the column.");
    else toast.success(`Duplicated "${column.name}".`);
  }

  /** Adds `count` blank rows, loads down to the end of the table and scrolls there. Returns an error message or null. */
  async function addRows(count: number): Promise<string | null> {
    const res = await grid.addRows(count);
    if (!res.ok) return res.error ?? "Could not add the rows.";
    for (let i = 0, pages = pagesToReachEnd(grid.total + count, 200, 200); i < pages; i += 1) await grid.loadMore();
    toast.success(`Added ${countOf(count, "row")}.`);
    // The grid is the one scroll container with role "grid". Wait a frame so the new rows are laid out.
    requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>('[role="grid"]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return null;
  }

  async function pasteBlock(request: BlockPasteRequest) {
    const outcome = await grid.pasteBlock(request);
    if (!outcome) return;
    toast.message(pasteSummary(outcome));
  }

  async function addRow() {
    setBusy(true);
    const res = await grid.addRows(1);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error ?? "Could not add a row. Try again.");
  }

  /** Deletes the selection in batches. Throws when the first batch fails so the dialog stays open with the message. */
  async function deleteSelected() {
    setBusy(true);
    const { deleted, failedFrom, error } = await grid.deleteRows(selectedIds).finally(() => setBusy(false));
    const report = deleteRowsReport(deleted, failedFrom < 0 ? 0 : selectedIds.length - failedFrom, error);
    if (report.kind === "failed") throw new Error(report.message);
    if (report.kind === "partial") {
      toast.error(report.message);
      // Keep the rows that are still there selected, so a retry is one click.
      setSelection({ ids: new Set(selectedIds.slice(failedFrom)), anchor: null });
    } else {
      toast.success(report.message);
      setSelection(emptySelection);
    }
  }

  async function selectAllMatching(): Promise<string[]> {
    const params = new URLSearchParams();
    if (grid.search.trim()) params.set("search", grid.search.trim());
    const res = await grid.cellRequest<{ rowIds: string[]; truncated: boolean }>(`${gridUrl.sub(tableId, "selection")}?${params}`, "GET");
    if (!res.ok || !res.data) {
      toast.error(res.error ?? "Could not select the rows.");
      return [];
    }
    if (res.data.truncated) toast.message(`Selection is limited to the first ${formatCount(res.data.rowIds.length)} rows.`);
    return res.data.rowIds;
  }

  async function exportCsv(onlySelected: boolean) {
    // Busy first, so a second click while queued edits land does not download twice.
    setBusy(true);
    try {
      // The file holds stored cells, so queued edits land first.
      if (!(await grid.settle())) return void toast.message(RESOLVE_CONFLICT_FIRST, { id: "grid-history" });
      const response = await fetch(gridUrl.sub(tableId, "export"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The server resolves the member's own view, so a filter, a sort and a personal view all carry over without the client sending them.
        body: JSON.stringify({ ...(onlySelected ? { rowIds: selectedIds } : { useView: true, search: grid.search.trim() }), columnKeys: visible.map((c) => c.key) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return void toast.error(body?.error ?? "Could not export.");
      }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = match?.[1] ?? `${grid.table?.name ?? "table"}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function pushToCampaign() {
    const ids = selectedIds.length > 0 ? selectedIds : await selectAllMatching();
    if (ids.length === 0) return void toast.message("There are no rows to push.");
    setDialog({ kind: "push", rowIds: ids, allRows: selectedIds.length === 0 });
  }

  async function toggleAutoRun(next: boolean) {
    const res = await grid.cellRequest(gridUrl.table(tableId), "PATCH", { autoRun: next });
    if (!res.ok) return void toast.error(res.error ?? "Could not change auto-run.");
    grid.setTable({ autoRun: next });
  }

  if (grid.status === "loading") {
    return (
      <div className="page">
        <PageSkeleton shape="table" label="Loading the table" />
      </div>
    );
  }
  if (grid.status === "error" || !grid.table) {
    return (
      <div className="page">
        <ErrorState
          title="The table did not load"
          reason={grid.error ?? "Could not load the table."}
          action={
            <Button variant="outline" touch onClick={() => void grid.reload()}>
              <RefreshCwIcon /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  const hasSelection = selectedIds.length > 0;
  const allLoadedSelected = hasSelection && selectedIds.length >= rows.length;
  const canSelectMore = allLoadedSelected && grid.total > rows.length;
  const emptyGrid =
    grid.search || filtersNarrow(view, types) ? (
      <EmptyState title="No rows match" description="Clear the search or loosen the filters to see the rest of the table." />
    ) : (
      <EmptyState
        title="This table has no rows yet"
        description="After you add rows, select a cell and paste values copied from a spreadsheet to fill them."
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog({ kind: "import" })}>Import file</Button>
            <Button variant="outline" onClick={() => setDialog({ kind: "addRows" })}>
              Add rows
            </Button>
          </div>
        }
      />
    );
  const detailsRow = dialog?.kind === "details" ? rows.find((r) => r.id === dialog.rowId) : undefined;
  const detailsColumn = dialog?.kind === "details" ? columns.find((c) => c.key === dialog.columnKey) : undefined;

  return (
    <CellRequestContext value={grid.cellRequest}>
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <TableToolbar
        tableId={tableId}
        columns={columns}
        hidden={hidden}
        search={grid.search}
        onSearch={grid.setSearch}
        busy={busy}
        saving={grid.saving}
        canUndo={grid.canUndo}
        canRedo={grid.canRedo}
        onUndo={withGridFocus(() => void grid.undo(), refocusGrid)}
        onRedo={withGridFocus(() => void grid.redo(), refocusGrid)}
        runnable={runnable}
        autoRun={grid.table.autoRun}
        total={grid.total}
        unfilteredTotal={grid.unfilteredTotal}
        jobs={grid.jobs}
        activeJobs={grid.activeJobs}
        onAddColumn={(kind) => setDialog(kind === "column" ? { kind: "column", request: { column: null, action: { kind: "add" } } } : { kind, column: null })}
        onEnrich={(outcome) => setDialog({ kind: "enrichment", column: null, outcome })}
        onAddAi={() => setDialog({ kind: "ai", column: null })}
        onAddRow={() => void addRow()}
        onAddRows={() => setDialog({ kind: "addRows" })}
        onImport={() => setDialog({ kind: "import" })}
        onExport={() => void exportCsv(false)}
        onPush={() => void pushToCampaign()}
        onRun={() => setDialog({ kind: "run", column: null })}
        onToggleAutoRun={(next) => void toggleAutoRun(next)}
        onToggleHidden={(key, hide) => void grid.saveView(toggleHidden(view, key, hide))}
        viewControls={
          <>
            <TableFilterPopover columns={columns} view={view} saveView={grid.saveView} />
            <TableSortPopover columns={columns} view={view} saveView={grid.saveView} />
          </>
        }
        onJobsChanged={() => void grid.reload()}
        onRetryFailed={grid.retryFailed}
        onShowFailed={() => void grid.saveView(withRunFailures(view, columns.filter((c) => c.type === "enrichment" || c.type === "waterfall" || c.type === "ai").map((c) => c.key)))}
      />

      {!runnable && grid.unfilteredTotal > 0 && (
        <EnrichStart onOutcome={(outcome) => setDialog({ kind: "enrichment", column: null, outcome })} onAi={() => setDialog({ kind: "ai", column: null })} />
      )}

      <ViewBar view={view} nameOf={nameOf} saveView={grid.saveView} personalView={grid.personalView} canEditDefault={grid.canEditDefault} onResetView={grid.resetView} onSaveDefaultView={grid.saveDefaultView} />

      {/* In the flow above the grid, not stuck to the viewport: the workbook page already fills the viewport height. */}
      <BulkBar
        sticky={false}
        count={selectedIds.length}
        actions={
          <>
            {canSelectMore && (
              <Button size="sm" variant="link" onClick={async () => setSelection({ ids: new Set(await selectAllMatching()), anchor: null })}>
                Select all {formatCount(grid.total)} matching rows
              </Button>
            )}
            {runnable && (
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "run", column: null })}>
                <PlayIcon /> Run
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "push", rowIds: selectedIds })}>
              <SendIcon /> Push to campaign
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportCsv(true)} disabled={busy}>
              <DownloadIcon /> Export
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "deleteRows", count: selectedIds.length })}>
              <Trash2Icon /> Delete
            </Button>
          </>
        }
        onClear={() => setSelection(emptySelection)}
      />

      {grid.stale && (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />
          This table changed elsewhere.
          <Button size="xs" variant="outline" onClick={() => void grid.reload()}>
            <RefreshCwIcon /> Reload
          </Button>
        </div>
      )}

      <DataGrid
        label={grid.table.name}
        columns={layout.columns}
        pinnedCount={layout.pinned}
        coverage={grid.coverage}
        pinnedKeys={phone ? [] : (view.pinnedColumns ?? [])}
        rows={rows}
        total={grid.total}
        selection={live}
        onSelection={setSelection}
        sorts={sorts}
        onEdit={grid.edit}
        keepsOrder={keepsTableOrder(view, grid.search, types)}
        onPasteBlock={(request) => void pasteBlock(request)}
        onUndo={() => void grid.undo()}
        onRedo={() => void grid.redo()}
        onColumnAction={onColumnAction}
        onLoadMore={() => void grid.loadMore()}
        onActiveChange={setActive}
        onRunCell={(cell) => void runCell(cell.column, cell.row.id)}
        canRunCell={(column) => runCellSource(column, columns) !== null}
        onOpenDetails={(cell) => setDialog({ kind: "details", rowId: cell.row.id, columnKey: cell.column.key })}
        focusToken={focusToken}
        reveal={reveal}
        empty={rows.length === 0 ? emptyGrid : undefined}
      />
      {grid.conflict && <ConflictDialog items={grid.conflict.items} columns={columns} rowNumbers={rowNumbers} onResolve={(choice) => { grid.resolveConflict(choice); setFocusToken((t) => t + 1); }} />}

      {dialog?.kind === "addRows" && <AddRowsDialog onAdd={addRows} onClose={closeDialog} />}
      {dialog?.kind === "import" && <TableImportDialog tableId={tableId} onClose={closeDialog} onImported={grid.reload} />}
      {dialog?.kind === "formula" && <FormulaDialog tableId={tableId} columns={columns} column={dialog.column} afterColumnId={dialog.after} previewRowId={active?.row.id} onClose={closeDialog} onSaved={grid.reload} />}
      {dialog?.kind === "enrichment" && <EnrichmentDialog tableId={tableId} columns={columns} column={dialog.column} afterColumnId={dialog.after} outcome={dialog.outcome} onClose={closeDialog} onSaved={async (key) => {
            await grid.reload();
            if (key) setReveal((r) => ({ key, token: (r?.token ?? 0) + 1 }));
          }} />}
      {dialog?.kind === "ai" && (
        <AiDialog
          tableId={tableId}
          columns={columns}
          column={dialog.column}
          afterColumnId={dialog.after}
          firstRowId={rows[0]?.id}
          onClose={closeDialog}
          onSaved={async (key) => {
            await grid.reload();
            if (key) setReveal((r) => ({ key, token: (r?.token ?? 0) + 1 }));
          }}
        />
      )}
      {dialog?.kind === "run" && <RunDialog tableId={tableId} column={dialog.column} selectedRowIds={selectedIds} initialFirstN={dialog.firstN} firstRun={!grid.jobs || grid.jobs.queued + grid.jobs.running + grid.jobs.waiting + grid.jobs.succeeded + grid.jobs.failed === 0} onClose={closeDialog} run={grid.runCells} />}
      {dialog?.kind === "push" && <PushCampaignDialog tableId={tableId} columns={columns} rowIds={dialog.rowIds} rowNumbers={rowNumbers} allRows={dialog.allRows} onClose={closeDialog} />}
      {dialog?.kind === "column" && (
        <ColumnDialogs tableId={tableId} columns={columns} view={view} request={dialog.request} onClose={closeDialog} onChanged={grid.reload} saveView={grid.saveView} dedupe={grid.dedupeColumn} />
      )}
      {dialog?.kind === "details" && detailsRow && detailsColumn && <CellDrawer
          tableId={tableId}
          row={detailsRow}
          column={detailsColumn}
          rowNumber={rowNumbers.get(detailsRow.id) ?? 0}
          onRun={runCellSource(detailsColumn, columns) !== null ? () => void runCell(detailsColumn, detailsRow.id) : undefined}
          columns={columns}
          onAddOutput={async (runner, outputKey, outputName) => {
            const res = await grid.addOutput(runner.id, outputKey);
            if (!res.ok) return void toast.error(res.error ?? "Could not add the column.");
            const filled = res.data?.filled ?? 0;
            toast.success(
              filled > 0
                ? `Added ${outputName} and filled ${countOf(filled, "row")} from answers ${runner.name} already has. Rows without one fill on its next run.`
                : `Added ${outputName}. It fills when ${runner.name} runs again.`,
            );
          }}
          onClose={closeDialog}
        />}
      {dialog?.kind === "deleteRows" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && closeDialog()}
          title={deleteRowsTitle(dialog.count, grid.table.name)}
          description="The rows and their run history are removed from this table. This cannot be undone."
          confirmLabel={dialog.count === 1 ? "Delete row" : "Delete rows"}
          cancelLabel={dialog.count === 1 ? "Keep row" : "Keep rows"}
          pendingLabel="Deleting…"
          destructive
          onConfirm={deleteSelected}
        />
      )}
    </div>
    </CellRequestContext>
  );
}
