import type { ActionSpec } from "../domain/enrichment-catalog";
import type { CascadeColumn } from "../domain/enrichment-cascade";
import type { StepAttempt } from "../domain/enrichment-waterfall";

/** A provider as the application sees it. There is deliberately no field for the credential. */
export interface ProviderRecord {
  id: string;
  key: string;
  name: string;
  baseUrl: string | null;
  defaultCostCents: number;
  rateLimitPerMin: number | null;
  config: Record<string, unknown>;
  enabled: boolean;
  hasCredential: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProvider {
  key: string;
  name: string;
  baseUrl: string | null;
  defaultCostCents: number;
  rateLimitPerMin: number | null;
  config: Record<string, unknown>;
}

export interface ProviderPatch {
  name?: string;
  baseUrl?: string | null;
  defaultCostCents?: number;
  rateLimitPerMin?: number | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ProviderStore {
  list(organizationId: string): Promise<ProviderRecord[]>;
  get(organizationId: string, id: string): Promise<ProviderRecord | null>;
  getByKey(organizationId: string, key: string): Promise<ProviderRecord | null>;
  /** Throws ConflictError when the key is taken. The envelope is stored in `grid_provider_credentials`. */
  create(organizationId: string, provider: NewProvider, encryptedCredential: string | null): Promise<ProviderRecord>;
  /** `encryptedCredential` replaces the stored envelope when given. */
  update(organizationId: string, id: string, patch: ProviderPatch, encryptedCredential?: string): Promise<ProviderRecord | null>;
  delete(organizationId: string, id: string): Promise<boolean>;
  /** Server-side only. The envelope never leaves the worker and the save path. */
  encryptedCredential(organizationId: string, providerId: string): Promise<string | null>;
}

export interface CredentialCipher {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
}

/** Thrown by an adapter. `transient` failures are retried, permanent ones are not. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly audit?: { request?: unknown; response?: unknown },
    /** For a transient failure the vendor told us to wait: the earliest retry, in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface ProviderCall {
  action: string;
  inputs: Record<string, unknown>;
  credentials: Record<string, string>;
  provider: ProviderRecord;
  timeoutMs: number;
}

export interface ProviderAnswer {
  outcome: "hit" | "miss";
  /**
   * The value for the column's own cell when it is a hit. On a miss it may hold the vendor's verdict that does not count
   * as found (a catch-all address); the cell shows it when no step of the column hits.
   */
  primary: unknown;
  outputs: Record<string, unknown>;
  /** Cents this call cost. Unset means the provider's configured price, or 0 when `billable` is false. */
  costCents?: number;
  /** False when the vendor charges nothing for this answer (no match, an unknown verdict). */
  billable?: boolean;
  request?: unknown;
  response?: unknown;
}

/** One way to ask a third party for data. Adapters hold no state and never see another organization's rows. */
export interface EnrichmentProvider {
  readonly adapter: string;
  actions(provider: ProviderRecord): ActionSpec[];
  execute(call: ProviderCall): Promise<ProviderAnswer>;
}

/** Picks the adapter for a provider row from its `config.adapter`. Null when none is installed. */
export interface AdapterRegistry {
  adapterFor(provider: ProviderRecord): EnrichmentProvider | null;
}

export interface ColumnRow extends CascadeColumn {
  id: string;
  name: string;
  position: number;
  updatedAt: Date;
}

export interface NewColumn {
  key: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  dependsOn: string[];
  position: number;
  autoRun: boolean;
}

/** What one locked column write does: new columns, edits to existing ones, and sibling moves that make room. */
export interface ColumnChange {
  inserts: NewColumn[];
  updates?: Array<{ id: string; config?: Record<string, unknown>; dependsOn?: string[]; autoRun?: boolean }>;
  renumber?: Array<{ id: string; position: number }>;
}

export interface ColumnChangeContext {
  /** The table's columns as they are under the lock, ordered by position. */
  columns: ColumnRow[];
  /** True when any row of the table holds a non-empty value under `columnKey`. */
  hasValues(columnKey: string): Promise<boolean>;
}

export interface GridRowRef {
  id: string;
  cells: Record<string, unknown>;
}

export interface EnqueueTarget {
  rowId: string;
  columnKey: string;
  delaySeconds?: number;
}

export interface CellJob {
  id: string;
  organizationId: string;
  tableId: string;
  rowId: string;
  columnKey: string;
  attempts: number;
  maxAttempts: number;
  providerState: { missed?: string[] } | null;
  /** The lease token. Every write that finishes the job is fenced by it. */
  lockedAt: Date;
}

export type RunOutcome = "hit" | "miss" | "error" | "failed" | "skipped" | "cancelled";

/** One ledger row (grid_cell_runs). */
export interface LedgerRun {
  provider: string | null;
  outcome: RunOutcome;
  costCents: number;
  latencyMs?: number | null;
  request?: unknown;
  response?: unknown;
}

/** Worst-case cents per cell of each runnable column, so the store can apply the cost cap inside the finishing transaction. */
export interface CascadeSpec {
  centsByColumn: Record<string, number>;
}

export interface CellWrite {
  cells: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface JobCounts {
  queued: number;
  running: number;
  waiting: number;
  succeeded: number;
  failed: number;
}

export interface CellRunView {
  id: string;
  provider: string | null;
  outcome: string;
  costCents: number;
  latencyMs: number | null;
  request: unknown;
  response: unknown;
  createdAt: Date;
}

export interface GridRunStore {
  tableAutoRun(organizationId: string, tableId: string): Promise<boolean | null>;
  listColumns(organizationId: string, tableId: string): Promise<ColumnRow[]>;
  /** Rows in table order. With `rowIds` only those rows, still scoped to the table. */
  /** Rows in table order (position, then id). `offset` skips that many rows of the same ordering. */
  listRows(organizationId: string, tableId: string, options: { rowIds?: string[]; limit: number; offset?: number }): Promise<GridRowRef[]>;
  /**
   * Runs `plan` under the table lock (the same row lock the column store takes), then applies its renumber, edits and
   * inserts in one transaction. `plan` may throw to refuse; nothing is written then. Null for an unknown table.
   * Throws ConflictError when a new key is taken.
   */
  changeColumns(organizationId: string, tableId: string, plan: (context: ColumnChangeContext) => Promise<ColumnChange> | ColumnChange): Promise<{ inserted: ColumnRow[]; updated: ColumnRow[] } | null>;
  updateColumn(organizationId: string, tableId: string, columnId: string, patch: { config?: Record<string, unknown>; dependsOn?: string[]; autoRun?: boolean }): Promise<ColumnRow | null>;

  /** One job per (row, column). A job that is queued again goes back to `queued`; a running one is left alone. Returns the cells queued. */
  enqueue(organizationId: string, tableId: string, targets: EnqueueTarget[], options: { priority: number; now: Date }): Promise<number>;
  /** Removes queued and waiting jobs, clears their cell state and writes a `cancelled` ledger row each. Running jobs finish. */
  cancel(organizationId: string, tableId: string): Promise<number>;
  /** Puts failed jobs back in the queue with a fresh attempt count. Succeeded cells are not touched. */
  retryFailed(organizationId: string, tableId: string, options: { columnKey?: string; now: Date }): Promise<number>;
  counts(organizationId: string, tableId: string): Promise<JobCounts>;
  /** Cells of the whole organization that are queued, running or waiting. */
  pendingCells(organizationId: string): Promise<number>;
  /** Marks cells the auto-run caps held back (`status: "skipped: cap"`). A cell with a live job is left alone. Returns the cells marked. */
  markSkipped(organizationId: string, tableId: string, cells: Array<{ rowId: string; columnKey: string }>, now: Date): Promise<number>;

  /**
   * Claims up to `limit` due jobs across organizations. A running job whose lease expired is taken over.
   * `sweepExhausted` (default true) also fails jobs that used all attempts; the worker asks for it once per pass.
   */
  claim(now: Date, leaseMs: number, limit: number, workerId: string, options?: { sweepExhausted?: boolean }): Promise<CellJob[]>;
  /** What a worker needs to run a job, read for the job's own organization. Null when the column or row is gone. */
  loadCell(job: CellJob): Promise<{ column: ColumnRow; columns: ColumnRow[]; cells: Record<string, unknown>; tableAutoRun: boolean } | null>;
  /** Call times (epoch ms) of this provider's calls since `since`, for the rate limit. */
  recentCalls(organizationId: string, providerKey: string, since: Date): Promise<number[]>;

  /** Each finisher returns false when the lease was lost, and then writes nothing. */
  succeed(job: CellJob, write: CellWrite, runs: LedgerRun[], cascade: CascadeSpec | false): Promise<boolean>;
  retryLater(job: CellJob, options: { runAfter: Date; error: string; consumeAttempt: boolean; missed: string[]; runs: LedgerRun[] }): Promise<boolean>;
  fail(job: CellJob, error: string, runs: LedgerRun[]): Promise<boolean>;
  /** The cell had nothing to work with. The job ends and the cell returns to idle. */
  skip(job: CellJob, reason: string): Promise<boolean>;

  cellRuns(organizationId: string, tableId: string, rowId: string, columnKey: string, limit: number): Promise<CellRunView[]>;
}

/** A free-form AI answer over cell values with the organization's own key. Null result means AI is not set up. */
export class GridAiError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export interface CellAnswerer {
  answer(
    organizationId: string,
    input: { instruction: string; cells: Array<{ key: string; value: string }>; outputs: Array<{ key: string; type: "text" | "number" | "boolean" | "email" | "url" | "date" | "json"; description?: string }> },
  ): Promise<{ output: Record<string, unknown>; provider: string; model: string; usage?: Record<string, number> } | null>;
}

export type { StepAttempt };
