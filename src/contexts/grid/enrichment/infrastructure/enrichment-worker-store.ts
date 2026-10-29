import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { gridCellRuns, gridColumns, gridJobs, gridRows, gridTables } from "@/platform/db/schema";
import { cascadeTargets } from "../domain/enrichment-cascade";
import { DEFAULT_CASCADE_LIMITS, ORG_MAX_PENDING_CELLS, ORG_MAX_RUNNING_CELLS, planCascade } from "../domain/enrichment-run-limits";
import { sanitizeOutput, sanitizeOutputString } from "../../domain/output-sanitize";
import type { CellJob, GridWorkerStore, LedgerRun } from "../application/enrichment-ports";
import { enqueueIn, jsonb, markSkippedIn, patchRow, pendingIn, toColumn } from "./enrichment-store-shared";

type Tx = DbTx;

async function removeMeta(tx: Tx, organizationId: string, tableId: string, rowId: string, columnKey: string) {
  await tx
    .update(gridRows)
    .set({ cellMeta: sql`${gridRows.cellMeta} - ${columnKey}::text`, updatedAt: new Date() })
    .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
}

/** The audit row may fail its foreign key when the row was deleted mid-run. Losing it must not undo the outcome. */
async function writeRuns(tx: Tx, job: Pick<CellJob, "organizationId" | "tableId" | "rowId" | "columnKey">, runs: LedgerRun[]) {
  if (runs.length === 0) return;
  // One statement means one `now()`, so give each attempt its own millisecond to keep the order they happened in.
  const base = Date.now();
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.insert(gridCellRuns).values(
        runs.map((r, i) => ({
          createdAt: new Date(base + i),
          organizationId: job.organizationId,
          tableId: job.tableId,
          rowId: job.rowId,
          columnKey: job.columnKey,
          outcome: r.outcome,
          costCents: String(r.costCents),
          credits: typeof r.credits === "number" ? String(r.credits) : null,
          lookupKey: r.lookupKey ?? null,
          answer: r.answer ? (sanitizeOutput(r.answer) as never) : null,
          reused: r.reused === true,
          latencyMs: r.latencyMs ?? null,
          provider: r.provider === null ? null : sanitizeOutputString(r.provider, 200),
          request: sanitizeOutput(r.request ?? null) as never,
          response: sanitizeOutput(r.response ?? null) as never,
        })),
      );
    });
  } catch (error) {
    console.warn("Could not record a grid cell run:", error instanceof Error ? error.message : error);
  }
}

/** Fences a finishing write by the lease token: a worker whose lease was taken over changes nothing. */
function fenced(job: CellJob) {
  return and(eq(gridJobs.id, job.id), eq(gridJobs.organizationId, job.organizationId), eq(gridJobs.status, "running"), eq(gridJobs.lockedAt, job.lockedAt));
}

const isoOf = (value: unknown) => new Date(String(value));

export const drizzleGridWorkerStore: GridWorkerStore = {
  async claim(now, leaseMs, limit, _workerId, options) {
    const expired = new Date(now.getTime() - leaseMs).toISOString();
    const stamp = now.toISOString();
    // A job whose lease ran out on its last attempt is finished, not run again.
    if (options?.sweepExhausted !== false) {
      const exhausted = (await db.execute(sql`
        update grid_jobs set status = 'failed', locked_at = null, updated_at = now(), error = 'The worker stopped during the last attempt.'
        where (status = 'running' and locked_at < ${expired}::timestamptz and attempts >= max_attempts) or (status = 'queued' and attempts >= max_attempts)
        returning organization_id, table_id, row_id, column_key
      `)) as unknown as Array<{ organization_id: string; table_id: string; row_id: string; column_key: string }>;
      for (const e of exhausted) {
        await db
          .update(gridRows)
          .set({ cellMeta: sql`${gridRows.cellMeta} || ${jsonb({ [e.column_key]: { status: "error", error: "The worker stopped during the last attempt.", runAt: stamp } })}`, updatedAt: new Date() })
          .where(and(eq(gridRows.organizationId, e.organization_id), eq(gridRows.tableId, e.table_id), eq(gridRows.id, e.row_id)));
      }
    }
    // One organization runs at most ORG_MAX_RUNNING_CELLS cells at once. A full organization's due jobs are passed over,
    // so another organization's queue is not starved behind a large paste. Below that cap the claim takes one job per
    // organization before a second job of any (`order by rn`), so a single cell waits one slot cycle behind a large run.
    const rows = (await db.execute(sql`
      with running as (
        select organization_id, count(*)::int as n from grid_jobs
        where status = 'running' and locked_at >= ${expired}::timestamptz
        group by organization_id
      ),
      due as (
        select j.id, j.priority, j.run_after, j.created_at,
          row_number() over (partition by j.organization_id order by j.priority desc, j.run_after, j.created_at) as rn,
          coalesce(r.n, 0) as running
        from grid_jobs j
        left join running r on r.organization_id = j.organization_id
        where j.attempts < j.max_attempts
          and ((j.status = 'queued' and j.run_after <= ${stamp}::timestamptz)
            or (j.status = 'running' and j.locked_at < ${expired}::timestamptz))
      ),
      candidate as (
        -- The lock sits on the outermost select, below the limit, so a row another claimer holds is skipped and the next
        -- candidate takes its place. A subselect with "limit" and the lock applied afterwards returned short.
        select j.id from grid_jobs j
        join due d on d.id = j.id
        where d.rn + d.running <= ${ORG_MAX_RUNNING_CELLS}
          -- Checked again under the row lock: another worker may have claimed the job since the snapshot above.
          and j.attempts < j.max_attempts
          and ((j.status = 'queued' and j.run_after <= ${stamp}::timestamptz)
            or (j.status = 'running' and j.locked_at < ${expired}::timestamptz))
        order by d.rn, j.priority desc, j.run_after, j.created_at
        limit ${limit}
        for update of j skip locked
      )
      update grid_jobs j
      set status = 'running', locked_at = ${stamp}::timestamptz, attempts = j.attempts + 1, updated_at = now()
      from candidate
      where j.id = candidate.id
      returning j.id, j.organization_id, j.table_id, j.row_id, j.column_key, j.attempts, j.max_attempts, j.provider_state
    `)) as unknown as Array<{ id: string; organization_id: string; table_id: string; row_id: string; column_key: string; attempts: number; max_attempts: number; provider_state: CellJob["providerState"] }>;
    const jobs: CellJob[] = rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      tableId: r.table_id,
      rowId: r.row_id,
      columnKey: r.column_key,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      providerState: r.provider_state,
      lockedAt: isoOf(stamp),
    }));
    // The grid shows progress while the call runs. Losing this write costs a spinner, nothing else.
    await Promise.all(
      jobs.map((j) =>
        db
          .update(gridRows)
          .set({ cellMeta: sql`${gridRows.cellMeta} || ${jsonb({ [j.columnKey]: { status: "running" } })}`, updatedAt: new Date() })
          .where(and(eq(gridRows.organizationId, j.organizationId), eq(gridRows.tableId, j.tableId), eq(gridRows.id, j.rowId)))
          .catch(() => undefined),
      ),
    );
    return jobs;
  },

  async loadCell(job) {
    const [columns, rowRows, table] = await Promise.all([
      db.select().from(gridColumns).where(and(eq(gridColumns.organizationId, job.organizationId), eq(gridColumns.tableId, job.tableId))).orderBy(asc(gridColumns.position)),
      db.select({ cells: gridRows.cells }).from(gridRows).where(and(eq(gridRows.organizationId, job.organizationId), eq(gridRows.tableId, job.tableId), eq(gridRows.id, job.rowId))),
      db.select({ autoRun: gridTables.autoRun }).from(gridTables).where(and(eq(gridTables.organizationId, job.organizationId), eq(gridTables.id, job.tableId))),
    ]);
    const column = columns.find((c) => c.key === job.columnKey);
    if (!column || !rowRows[0] || !table[0]) return null;
    return { column: toColumn(column), columns: columns.map(toColumn), cells: rowRows[0].cells, tableAutoRun: table[0].autoRun };
  },

  async recentCalls(organizationId, providerKey, since) {
    const rows = await db
      .select({ at: gridCellRuns.createdAt })
      .from(gridCellRuns)
      .where(and(eq(gridCellRuns.organizationId, organizationId), eq(gridCellRuns.provider, providerKey), inArray(gridCellRuns.outcome, ["hit", "miss", "error"]), eq(gridCellRuns.reused, false), sql`${gridCellRuns.createdAt} > ${since.toISOString()}::timestamptz`));
    return rows.map((r) => r.at.getTime());
  },

  async reusableAnswer(organizationId, lookupKey, since) {
    const [row] = await db
      .select({ id: gridCellRuns.id, createdAt: gridCellRuns.createdAt, outcome: gridCellRuns.outcome, answer: gridCellRuns.answer })
      .from(gridCellRuns)
      .where(and(eq(gridCellRuns.organizationId, organizationId), eq(gridCellRuns.lookupKey, lookupKey), sql`${gridCellRuns.createdAt} > ${since.toISOString()}::timestamptz`))
      .orderBy(desc(gridCellRuns.createdAt))
      .limit(1);
    const answer = row?.answer as { primary?: unknown; outputs?: unknown; outcome?: unknown } | null | undefined;
    if (!row || (row.outcome !== "hit" && row.outcome !== "miss") || !answer || typeof answer.outputs !== "object" || answer.outputs === null) return null;
    // The vendor's own outcome when the row kept it; the reusing column applies its own settled verdicts to it.
    const outcome = answer.outcome === "hit" || answer.outcome === "miss" ? answer.outcome : row.outcome;
    return { id: row.id, createdAt: row.createdAt, outcome, answer: { primary: answer.primary ?? null, outputs: answer.outputs as Record<string, unknown> } };
  },

  async succeed(job, write, runs, cascade) {
    return db.transaction(async (tx) => {
      const done = await tx.update(gridJobs).set({ status: "succeeded", lockedAt: null, error: null, providerState: null, updatedAt: new Date() }).where(fenced(job)).returning({ id: gridJobs.id });
      if (done.length === 0) return false;
      // Only keys that are still columns: an output column deleted while the job ran must not keep receiving values.
      const live = new Set((await tx.select({ key: gridColumns.key }).from(gridColumns).where(and(eq(gridColumns.organizationId, job.organizationId), eq(gridColumns.tableId, job.tableId)))).map((c) => c.key));
      const cells = Object.fromEntries(Object.entries(write.cells).filter(([k]) => live.has(k)));
      const meta = Object.fromEntries(Object.entries(write.meta).filter(([k]) => live.has(k)));
      // Outcome metadata is written even when no cell value is left (a provider miss, or every output column deleted mid-run).
      // Without it the "running" mark set in claim would stay and the grid would spin forever.
      await patchRow(tx, job.organizationId, job.tableId, job.rowId, cells, meta);
      if (!live.has(job.columnKey)) await removeMeta(tx, job.organizationId, job.tableId, job.rowId, job.columnKey);
      await writeRuns(tx, job, runs);
      if (cascade) {
        try {
          await tx.transaction(async (savepoint) => {
            const [table] = await savepoint.select({ autoRun: gridTables.autoRun }).from(gridTables).where(and(eq(gridTables.organizationId, job.organizationId), eq(gridTables.id, job.tableId)));
            if (!table?.autoRun) return;
            const [fresh] = await savepoint.select({ cells: gridRows.cells }).from(gridRows).where(and(eq(gridRows.organizationId, job.organizationId), eq(gridRows.tableId, job.tableId), eq(gridRows.id, job.rowId)));
            if (!fresh) return;
            const columns = (await savepoint.select().from(gridColumns).where(and(eq(gridColumns.organizationId, job.organizationId), eq(gridColumns.tableId, job.tableId)))).map(toColumn);
            const ready = cascadeTargets(columns, fresh.cells, Object.keys(cells)).filter((c) => c.key !== job.columnKey && !cascade.unreachable?.includes(c.key));
            if (ready.length === 0) return;
            // The same caps as an edit's cascade: worst-case cost of this row's dependents and the room left in the organization's queue.
            const plan = planCascade(
              ready.map((c) => ({ rowId: job.rowId, columnKey: c.key, cents: cascade.centsByColumn[c.key] ?? 0 })),
              { ...DEFAULT_CASCADE_LIMITS, room: Math.max(0, ORG_MAX_PENDING_CELLS - (await pendingIn(savepoint, job.organizationId))) },
            );
            if (plan.allowed.length > 0) await enqueueIn(savepoint, job.organizationId, job.tableId, plan.allowed, { priority: 0, now: new Date() });
            if (plan.skipped.length > 0) await markSkippedIn(savepoint, job.organizationId, job.tableId, plan.skipped, new Date());
          });
        } catch (error) {
          console.error(`Grid cascade after ${job.columnKey} failed:`, error instanceof Error ? error.message : error);
        }
      }
      return true;
    });
  },

  async retryLater(job, options) {
    return db.transaction(async (tx) => {
      const done = await tx
        .update(gridJobs)
        .set({
          status: "queued",
          lockedAt: null,
          error: sanitizeOutputString(options.error, 1000),
          runAfter: options.runAfter,
          attempts: options.consumeAttempt ? job.attempts : Math.max(0, job.attempts - 1),
          // Any key counts, `fresh` and `inputsKey` too: a fresh run that waits must still skip reuse on its next try.
          providerState: Object.keys(options.state).length > 0 ? options.state : null,
          updatedAt: new Date(),
        })
        .where(fenced(job))
        .returning({ id: gridJobs.id });
      if (done.length === 0) return false;
      // The cell says why it waits and until when, so a long vendor wait is not a spinner without a reason.
      await patchRow(tx, job.organizationId, job.tableId, job.rowId, {}, { [job.columnKey]: { status: "queued", reason: sanitizeOutputString(options.error, 300), runAfter: options.runAfter.toISOString() } });
      await writeRuns(tx, job, options.runs);
      return true;
    });
  },

  async fail(job, error, runs, state) {
    return db.transaction(async (tx) => {
      const done = await tx
        .update(gridJobs)
        .set({ status: "failed", lockedAt: null, error: sanitizeOutputString(error, 1000), ...(state ? { providerState: state } : {}), updatedAt: new Date() })
        .where(fenced(job))
        .returning({ id: gridJobs.id });
      if (done.length === 0) return false;
      await patchRow(tx, job.organizationId, job.tableId, job.rowId, {}, { [job.columnKey]: { status: "error", error: sanitizeOutputString(error, 500), runAt: new Date().toISOString() } });
      await writeRuns(tx, job, runs);
      return true;
    });
  },

  async skip(job, reason) {
    return db.transaction(async (tx) => {
      const done = await tx.update(gridJobs).set({ status: "succeeded", lockedAt: null, error: null, providerState: null, updatedAt: new Date() }).where(fenced(job)).returning({ id: gridJobs.id });
      if (done.length === 0) return false;
      await removeMeta(tx, job.organizationId, job.tableId, job.rowId, job.columnKey);
      await writeRuns(tx, job, [{ provider: null, outcome: "skipped", costCents: 0, response: { reason } }]);
      return true;
    });
  },
};
