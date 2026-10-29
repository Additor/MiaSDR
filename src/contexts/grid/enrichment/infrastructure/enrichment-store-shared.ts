import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { gridColumns, gridJobs, gridRows } from "@/platform/db/schema";
import { SKIPPED_CAP_MESSAGE, SKIPPED_CAP_STATUS } from "../domain/enrichment-run-limits";
import { sanitizeOutput } from "../../domain/output-sanitize";
import type { ColumnRow, EnqueueTarget } from "../application/enrichment-ports";

// Writes both grid stores make: the run store when a person queues cells, the worker store when a result cascades.

type Tx = DbTx;

export const CHUNK = 500;
/** New work is due a minute in the past: the claim compares `run_after` with the worker's clock, not the database's. */
export const DUE_SKEW_MS = 60_000;

export const toColumn = (c: typeof gridColumns.$inferSelect): ColumnRow => ({
  id: c.id,
  key: c.key,
  name: c.name,
  type: c.type,
  config: c.config,
  dependsOn: c.dependsOn,
  position: c.position,
  autoRun: c.autoRun,
  updatedAt: c.updatedAt,
});

/** Every jsonb write goes through here: Postgres rejects \u0000 and lone surrogates, and a rejected write after a paid call re-bills. */
export const jsonb = (value: unknown) => sql`${JSON.stringify(sanitizeOutput(value))}::jsonb`;

/** A job's state when it is queued again: the tries' work stays, the fresh flag and the free-wait count go. */
export const requeuedState = sql`nullif(${gridJobs.providerState} - 'fresh' - 'waits', '{}'::jsonb)`;

/** Merges cell values and metadata into one row. The version trigger bumps `grid_rows.version`. */
export async function patchRow(tx: Tx, organizationId: string, tableId: string, rowId: string, cells: Record<string, unknown>, meta: Record<string, unknown>) {
  await tx
    .update(gridRows)
    .set({ cells: sql`${gridRows.cells} || ${jsonb(cells)}`, cellMeta: sql`${gridRows.cellMeta} || ${jsonb(meta)}`, updatedAt: new Date() })
    .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
}

export async function markQueued(tx: Tx, organizationId: string, tableId: string, cells: Array<{ rowId: string; columnKey: string }>) {
  const byRow = new Map<string, Record<string, unknown>>();
  for (const c of cells) byRow.set(c.rowId, { ...(byRow.get(c.rowId) ?? {}), [c.columnKey]: { status: "queued" } });
  for (const [rowId, meta] of byRow) {
    await tx
      .update(gridRows)
      .set({ cellMeta: sql`${gridRows.cellMeta} || ${jsonb(meta)}`, updatedAt: new Date() })
      .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
  }
}

export async function enqueueIn(tx: Tx, organizationId: string, tableId: string, targets: EnqueueTarget[], options: { priority: number; now: Date; fresh?: boolean }): Promise<number> {
  let queued = 0;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    // Only rows of this table in this organization. The composite foreign keys alone would accept another table's row.
    const valid = new Set(
      (await tx.select({ id: gridRows.id }).from(gridRows).where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), inArray(gridRows.id, chunk.map((t) => t.rowId))))).map((r) => r.id),
    );
    const live = chunk.filter((t) => valid.has(t.rowId));
    if (live.length === 0) continue;
    const inserted = await tx
      .insert(gridJobs)
      .values(
        live.map((t) => ({
          organizationId,
          tableId,
          rowId: t.rowId,
          columnKey: t.columnKey,
          status: "queued",
          priority: options.priority,
          attempts: 0,
          providerState: options.fresh ? { fresh: true } : null,
          runAfter: new Date(options.now.getTime() - DUE_SKEW_MS + (t.delaySeconds ?? 0) * 1000),
        })),
      )
      .onConflictDoUpdate({
        target: [gridJobs.rowId, gridJobs.columnKey],
        // Queuing again keeps the steps that missed, the verdict and the spend of earlier tries, so nothing is paid
        // twice and the caps hold; the worker drops that state when the inputs changed. It drops the fresh flag and
        // the free-wait count, which belong to the run that set them. A queued job also keeps a later run_after,
        // which is a vendor's wait. A fresh run starts over.
        set: {
          status: "queued",
          attempts: 0,
          error: null,
          providerState: options.fresh ? sql`'{"fresh":true}'::jsonb` : requeuedState,
          lockedAt: null,
          priority: options.priority,
          runAfter: options.fresh ? sql`excluded.run_after` : sql`case when ${gridJobs.status} = 'queued' then greatest(${gridJobs.runAfter}, excluded.run_after) else excluded.run_after end`,
          updatedAt: new Date(),
        },
        // A job in flight is left alone: queuing it again would orphan the run in progress.
        where: sql`${gridJobs.status} not in ('running', 'waiting')`,
      })
      .returning({ rowId: gridJobs.rowId, columnKey: gridJobs.columnKey });
    await markQueued(tx, organizationId, tableId, inserted);
    queued += inserted.length;
  }
  return queued;
}

/** Cells with a queued, running or waiting job. A cell with a live job keeps its own status. */
export async function pendingIn(tx: Tx, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(gridJobs)
    .where(and(eq(gridJobs.organizationId, organizationId), inArray(gridJobs.status, ["queued", "running", "waiting"])));
  return row?.n ?? 0;
}

export async function markSkippedIn(tx: Tx, organizationId: string, tableId: string, cells: Array<{ rowId: string; columnKey: string }>, now: Date): Promise<number> {
  let marked = 0;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const chunk = cells.slice(i, i + CHUNK);
    const live = await tx
      .select({ rowId: gridJobs.rowId, columnKey: gridJobs.columnKey })
      .from(gridJobs)
      .where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), inArray(gridJobs.rowId, chunk.map((c) => c.rowId)), inArray(gridJobs.status, ["queued", "running", "waiting"])));
    const busy = new Set(live.map((j) => `${j.rowId}\u0001${j.columnKey}`));
    const byRow = new Map<string, Record<string, unknown>>();
    for (const c of chunk) {
      if (busy.has(`${c.rowId}\u0001${c.columnKey}`)) continue;
      byRow.set(c.rowId, { ...(byRow.get(c.rowId) ?? {}), [c.columnKey]: { status: SKIPPED_CAP_STATUS, reason: SKIPPED_CAP_MESSAGE, runAt: now.toISOString() } });
      marked++;
    }
    for (const [rowId, meta] of byRow) await patchRow(tx, organizationId, tableId, rowId, {}, meta);
  }
  return marked;
}
