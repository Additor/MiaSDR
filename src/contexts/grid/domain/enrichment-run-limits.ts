import { ValidationError } from "@/shared/errors";

/** Spend and size limits for one run request. The queue itself never grows past `maxRows` x columns per request. */
export const DEFAULT_MAX_ROWS = 1000;
export const HARD_MAX_ROWS = 10_000;
export const DEFAULT_CONCURRENCY = 8;
export const HARD_MAX_CONCURRENCY = 16;
/**
 * Safety ceiling on the cells one pass claims. The time budget of the tick is the real limit: at the slowest
 * useful rate (16 slots, 8 ms per cell) a 50 second budget would allow far more, so the ceiling only stops a runaway loop.
 */
export const MAX_JOBS_PER_TICK = 2000;

export interface RunRequest {
  columnKey?: string;
  rowIds?: string[];
  onlyEmpty?: boolean;
  /** Refuse the run when more rows than this would be queued. Default 1000, at most 10000. It never truncates; `firstN` does. */
  maxRows?: number;
  /**
   * Run only the first N rows, in table order, that have a cell to queue. Rows the `onlyEmpty` filter or a missing
   * input already skips do not use up the count. N may not pass `maxRows`.
   */
  firstN?: number;
  /** Refuse the run when the worst-case provider cost in cents is higher. No cap when unset. */
  maxCostCents?: number;
  /** Ask the providers again: no reused answer, and no state from an earlier try. A person's press on one cell sets it. */
  fresh?: boolean;
  /** Only estimate: nothing is queued, and a limit the run would break comes back as `problem` instead of an error. */
  dryRun?: boolean;
}

export function resolveMaxRows(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_ROWS;
  if (!Number.isInteger(requested) || requested < 1 || requested > HARD_MAX_ROWS) {
    throw new ValidationError(`maxRows must be a whole number from 1 to ${HARD_MAX_ROWS}.`);
  }
  return requested;
}

/** Rows one first-N run reads from the table while it looks for N rows with something to run. */
export const MAX_SCAN_ROWS = 100_000;
/** Rows read per query during that scan. */
export const SCAN_PAGE_ROWS = 500;

export function resolveFirstN(requested: number | undefined, maxRows: number): number | undefined {
  if (requested === undefined) return undefined;
  if (!Number.isInteger(requested) || requested < 1 || requested > HARD_MAX_ROWS) {
    throw new ValidationError(`firstN must be a whole number from 1 to ${HARD_MAX_ROWS}.`);
  }
  if (requested > maxRows) {
    throw new ValidationError(`First ${requested.toLocaleString("en-US")} rows is more than the row limit of ${maxRows.toLocaleString("en-US")}. Lower the number or raise the row limit.`);
  }
  return requested;
}

export function clampConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CONCURRENCY;
  return Math.min(HARD_MAX_CONCURRENCY, Math.max(1, Math.floor(requested)));
}

/** Throws when a run would pass its row or cost limit. `worstCaseCents` is the sum over every cell the run queues. */
export function assertWithinLimits(input: { rows: number; worstCaseCents: number; maxRows: number; maxCostCents?: number }): number {
  if (input.rows > input.maxRows) {
    throw new ValidationError(`This run has more rows than the limit of ${input.maxRows.toLocaleString("en-US")}. Select fewer rows or raise the row limit.`);
  }
  const estimate = input.worstCaseCents;
  if (input.maxCostCents !== undefined && estimate > input.maxCostCents) {
    throw new ValidationError(`The worst-case cost of this run is ${estimate.toFixed(2)} cents and the limit is ${input.maxCostCents}.`);
  }
  return estimate;
}

/**
 * Limits for work queued without a person pressing Run: the auto-run cascade after an edit, a paste or a finished cell.
 * One paste of 1,000 rows must not queue 1,000 paid calls per auto-run column, so each cascade event is capped on its own.
 */
export const CASCADE_MAX_ROWS = 100;
/** Worst-case provider cost, in cents, one cascade event may queue across all its columns. */
export const CASCADE_MAX_COST_CENTS = 500;
/** Cells one organization may have queued, running or waiting. A cascade only fills the room left under it. */
export const ORG_MAX_PENDING_CELLS = 2000;
/** Cells one organization may run at the same time across all workers. Other organizations' jobs are claimed first when it is full. */
export const ORG_MAX_RUNNING_CELLS = 8;
/** Cell status of a cascade target the caps held back. The cell keeps its old value and the person can run it by hand. */
export const SKIPPED_CAP_STATUS = "skipped: cap";
export const SKIPPED_CAP_MESSAGE = "Not run automatically: this change touched more cells than the auto-run limit allows. Run the column to fill it.";

export interface CascadeCandidate {
  rowId: string;
  columnKey: string;
  /** Worst-case cents of this cell. */
  cents: number;
  delaySeconds?: number;
}

export interface CascadeLimits {
  maxRowsPerColumn: number;
  maxCostCents: number;
  /** Cells the organization can still add before it reaches its pending cap. */
  room: number;
}

export interface CascadePlan<T extends CascadeCandidate = CascadeCandidate> {
  allowed: T[];
  skipped: T[];
}

/** Splits candidates, in the order given, into the cells the caps let through and the cells they hold back. */
export function planCascade<T extends CascadeCandidate>(candidates: readonly T[], limits: CascadeLimits): CascadePlan<T> {
  const allowed: T[] = [];
  const skipped: T[] = [];
  const perColumn = new Map<string, number>();
  let cents = 0;
  for (const candidate of candidates) {
    const rows = perColumn.get(candidate.columnKey) ?? 0;
    const fits = rows < limits.maxRowsPerColumn && cents + candidate.cents <= limits.maxCostCents && allowed.length < limits.room;
    if (!fits) {
      skipped.push(candidate);
      continue;
    }
    perColumn.set(candidate.columnKey, rows + 1);
    cents += candidate.cents;
    allowed.push(candidate);
  }
  return { allowed, skipped };
}

export const DEFAULT_CASCADE_LIMITS = { maxRowsPerColumn: CASCADE_MAX_ROWS, maxCostCents: CASCADE_MAX_COST_CENTS } as const;
