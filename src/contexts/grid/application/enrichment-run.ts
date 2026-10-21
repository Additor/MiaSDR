import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { cascadeTargets, inputsReady, RUNNABLE_TYPES, runRoots } from "../domain/enrichment-cascade";
import { assertWithinLimits, DEFAULT_CASCADE_LIMITS, MAX_SCAN_ROWS, ORG_MAX_PENDING_CELLS, planCascade, resolveFirstN, resolveMaxRows, SCAN_PAGE_ROWS, type CascadeCandidate, type RunRequest } from "../domain/enrichment-run-limits";
import { hasCellValue } from "../domain/enrichment-templates";
import type { AdapterRegistry, CellRunView, EnqueueTarget, GridRunStore, JobCounts, ProviderStore, ProviderUsage } from "./enrichment-ports";
import { cellCents, preflight } from "./enrichment-cost";

export interface RunDeps {
  store: GridRunStore;
  providers: ProviderStore;
  adapters: AdapterRegistry;
  now: () => Date;
  /** Asks this process to run the queued cells now instead of at the next tick. Called after the queue write commits; its failure never reaches the caller. */
  kick?: () => void;
}

/** The queue write is committed. The kick only schedules a later pass, so it cannot slow or fail the request. */
function kickWorker(deps: RunDeps, queued: number): void {
  if (queued <= 0) return;
  try {
    deps.kick?.();
  } catch {
    // The tick picks the cells up.
  }
}

export interface RunReport {
  queued: number;
  rows: number;
  columns: string[];
  /** Highest cost in cents the queued cells can add up to, from each provider's price. */
  worstCaseCostCents: number;
  jobs: JobCounts;
}

async function requireTable(deps: RunDeps, actor: Actor, tableId: string): Promise<boolean> {
  const autoRun = await deps.store.tableAutoRun(actor.organizationId, tableId);
  if (autoRun === null) throw new NotFoundError("Table not found");
  return autoRun;
}

/**
 * Queues the runnable columns for the chosen rows. With no column, only the roots of the dependency graph are
 * queued; the dependents follow when their inputs land. Re-running is idempotent: a cell has one job.
 */
export async function requestRun(deps: RunDeps, actor: Actor, tableId: string, request: RunRequest = {}): Promise<RunReport> {
  await requireTable(deps, actor, tableId);
  const org = actor.organizationId;
  const maxRows = resolveMaxRows(request.maxRows);
  if (request.maxCostCents !== undefined && (!Number.isFinite(request.maxCostCents) || request.maxCostCents < 0)) throw new ValidationError("maxCostCents must be zero or more.");

  const columns = await deps.store.listColumns(org, tableId);
  const runnable = columns.filter((c) => RUNNABLE_TYPES.has(c.type));
  if (runnable.length === 0) throw new ValidationError("This table has no enrichment, waterfall or AI columns.");
  let targets = runnable;
  if (request.columnKey) {
    const one = runnable.find((c) => c.key === request.columnKey);
    if (!one) throw new ValidationError(`"${request.columnKey}" is not a runnable column.`);
    targets = [one];
  } else {
    targets = runRoots(columns).map((root) => runnable.find((c) => c.key === root.key)!);
  }

  const perCell = new Map<string, number>();
  for (const column of targets) perCell.set(column.key, await preflight(deps, org, column));

  const firstN = resolveFirstN(request.firstN, maxRows);
  // Duplicate ids count once: pressing a cell twice is still one row.
  const rowIds = request.rowIds ? [...new Set(request.rowIds)] : undefined;
  if (rowIds !== undefined && rowIds.length > maxRows && firstN === undefined) {
    throw new ValidationError(`This run covers ${rowIds.length.toLocaleString("en-US")} rows and the row limit is ${maxRows.toLocaleString("en-US")}. Select fewer rows or raise the row limit.`);
  }

  // The cells one row adds to the queue: inputs ready, and empty when the run skips filled cells.
  const cellsOf = (row: { id: string; cells: Record<string, unknown> }): EnqueueTarget[] => {
    const cells: EnqueueTarget[] = [];
    for (const column of targets) {
      if (!inputsReady(column, row.cells)) continue;
      if (request.onlyEmpty && hasCellValue(row.cells[column.key])) continue;
      const delay = Number((column.config as { delaySeconds?: unknown }).delaySeconds ?? 0);
      cells.push({ rowId: row.id, columnKey: column.key, delaySeconds: Number.isFinite(delay) && delay > 0 ? delay : 0 });
    }
    return cells;
  };

  const queue: EnqueueTarget[] = [];
  let worst = 0;
  const add = (cells: EnqueueTarget[]) => {
    for (const cell of cells) {
      queue.push(cell);
      worst += perCell.get(cell.columnKey) ?? 0;
    }
  };
  let rowCount: number;
  if (firstN === undefined) {
    // One extra row tells us the table is bigger than the limit without reading all of it.
    const rows = await deps.store.listRows(org, tableId, { rowIds, limit: maxRows + 1 });
    for (const row of rows) add(cellsOf(row));
    rowCount = rows.length;
  } else {
    // Walk the table in order, page by page, and stop once N rows have something to run.
    rowCount = 0;
    for (let offset = 0; rowCount < firstN && offset < MAX_SCAN_ROWS; offset += SCAN_PAGE_ROWS) {
      const page = await deps.store.listRows(org, tableId, { rowIds, limit: SCAN_PAGE_ROWS, offset });
      for (const row of page) {
        const cells = cellsOf(row);
        if (cells.length === 0) continue;
        add(cells);
        if (++rowCount >= firstN) break;
      }
      if (page.length < SCAN_PAGE_ROWS) break;
    }
  }
  assertWithinLimits({ rows: rowCount, worstCaseCents: worst, maxRows, maxCostCents: request.maxCostCents });

  const queued = await deps.store.enqueue(org, tableId, queue, { priority: request.columnKey ? 10 : 0, now: deps.now() });
  kickWorker(deps, queued);
  return { queued, rows: rowCount, columns: targets.map((c) => c.key), worstCaseCostCents: worst, jobs: await deps.store.counts(org, tableId) };
}

/** The Stop button. Queued cells go back to idle, each with a `cancelled` ledger row. A cell that is mid-call finishes. */
export async function cancelRun(deps: RunDeps, actor: Actor, tableId: string): Promise<{ cancelled: number; jobs: JobCounts }> {
  await requireTable(deps, actor, tableId);
  const cancelled = await deps.store.cancel(actor.organizationId, tableId);
  return { cancelled, jobs: await deps.store.counts(actor.organizationId, tableId) };
}

/** Re-queues failed cells only. Cells that succeeded, missed or were cancelled stay as they are. */
export async function retryFailedCells(deps: RunDeps, actor: Actor, tableId: string, columnKey?: string): Promise<{ retried: number; jobs: JobCounts }> {
  await requireTable(deps, actor, tableId);
  const retried = await deps.store.retryFailed(actor.organizationId, tableId, { columnKey, now: deps.now() });
  kickWorker(deps, retried);
  return { retried, jobs: await deps.store.counts(actor.organizationId, tableId) };
}

export async function runStatus(deps: RunDeps, actor: Actor, tableId: string): Promise<JobCounts> {
  await requireTable(deps, actor, tableId);
  return deps.store.counts(actor.organizationId, tableId);
}

export interface CascadeReport {
  queued: number;
  /** Cells the auto-run caps held back. They are marked `skipped: cap` and wait for a person to run them. */
  skippedByCap: number;
}

/**
 * Cell edits, pastes and imports call this: queues the auto-run columns that read what changed, within the cascade
 * limits (rows per column, worst-case cost, room left in the organization's queue). Cells the limits hold back are
 * marked `skipped: cap` and counted so the caller can tell the person. Honors the table and column auto-run switches.
 */
export async function cascadeFromEdits(deps: RunDeps, organizationId: string, tableId: string, changes: ReadonlyMap<string, readonly string[]>): Promise<CascadeReport> {
  const none: CascadeReport = { queued: 0, skippedByCap: 0 };
  if (changes.size === 0 || !(await deps.store.tableAutoRun(organizationId, tableId))) return none;
  const rowIds = [...changes.keys()];
  const [columns, rows] = await Promise.all([deps.store.listColumns(organizationId, tableId), deps.store.listRows(organizationId, tableId, { rowIds, limit: rowIds.length })]);
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const centsByColumn = new Map<string, number>();
  const candidates: CascadeCandidate[] = [];
  for (const row of rows) {
    for (const column of cascadeTargets(columns, row.cells, changes.get(row.id) ?? [])) {
      if (!centsByColumn.has(column.key)) centsByColumn.set(column.key, await cellCents(deps, organizationId, byKey.get(column.key)!));
      const delay = Number((column.config as { delaySeconds?: unknown }).delaySeconds ?? 0);
      candidates.push({ rowId: row.id, columnKey: column.key, cents: centsByColumn.get(column.key) ?? 0, delaySeconds: Number.isFinite(delay) && delay > 0 ? delay : 0 });
    }
  }
  if (candidates.length === 0) return none;
  const room = Math.max(0, ORG_MAX_PENDING_CELLS - (await deps.store.pendingCells(organizationId)));
  const plan = planCascade(candidates, { ...DEFAULT_CASCADE_LIMITS, room });
  const now = deps.now();
  const queued = plan.allowed.length > 0 ? await deps.store.enqueue(organizationId, tableId, plan.allowed, { priority: 0, now }) : 0;
  kickWorker(deps, queued);
  if (plan.skipped.length > 0) await deps.store.markSkipped(organizationId, tableId, plan.skipped, now);
  return { queued, skippedByCap: plan.skipped.length };
}

/** Run ledger of one cell, newest first. Output columns resolve to the column that produced them. */
export const USAGE_DAYS = 30;

/** Each provider's calls, results, credits and cost in the organization over the last `days` days. */
export async function providerUsage(deps: RunDeps, actor: Actor, days = USAGE_DAYS): Promise<{ days: number; usage: ProviderUsage[] }> {
  const span = Math.max(1, Math.min(365, Math.floor(days)));
  return { days: span, usage: await deps.store.providerUsage(actor.organizationId, new Date(deps.now().getTime() - span * 86_400_000)) };
}

export async function cellRuns(deps: RunDeps, actor: Actor, tableId: string, rowId: string, columnKey: string): Promise<{ sourceColumnKey: string; runs: CellRunView[] }> {
  await requireTable(deps, actor, tableId);
  const columns = await deps.store.listColumns(actor.organizationId, tableId);
  const column = columns.find((c) => c.key === columnKey);
  if (!column) throw new NotFoundError("Cell not found");
  const source = typeof column.config.sourceColumnKey === "string" && (column.type === "integration_output" || column.type === "ai_output") ? column.config.sourceColumnKey : column.key;
  const owner = columns.find((c) => c.key === source);
  if (!owner || !RUNNABLE_TYPES.has(owner.type)) throw new NotFoundError("This cell has no run history.");
  return { sourceColumnKey: source, runs: await deps.store.cellRuns(actor.organizationId, tableId, rowId, source, 50) };
}
