import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ConflictError, ValidationError } from "@/shared/errors";
import { db, type DbTx } from "@/platform/db/client";
import { gridCellRuns, gridColumns, gridJobs, gridRows, gridTables } from "@/platform/db/schema";
import { GRID_LIMITS } from "../../application/limits";
import { cascadeTargets } from "../domain/enrichment-cascade";
import { DEFAULT_CASCADE_LIMITS, ORG_MAX_PENDING_CELLS, ORG_MAX_RUNNING_CELLS, planCascade, SKIPPED_CAP_MESSAGE, SKIPPED_CAP_STATUS } from "../domain/enrichment-run-limits";
import { sanitizeOutput, sanitizeOutputString } from "../../domain/output-sanitize";
import type { CellJob, ColumnRow, EnqueueTarget, GridRunStore, JobCounts, LedgerRun } from "../application/enrichment-ports";

type Tx = DbTx;

const CHUNK = 500;
/** New work is due a minute in the past: the claim compares `run_after` with the worker's clock, not the database's. */
const DUE_SKEW_MS = 60_000;

const toColumn = (c: typeof gridColumns.$inferSelect): ColumnRow => ({
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
const jsonb = (value: unknown) => sql`${JSON.stringify(sanitizeOutput(value))}::jsonb`;

/** A job's state when it is queued again: the tries' work stays, the fresh flag and the free-wait count go. */
const requeuedState = sql`nullif(${gridJobs.providerState} - 'fresh' - 'waits', '{}'::jsonb)`;

/** Merges cell values and metadata into one row. The version trigger bumps `grid_rows.version`. */
async function patchRow(tx: Tx, organizationId: string, tableId: string, rowId: string, cells: Record<string, unknown>, meta: Record<string, unknown>) {
  await tx
    .update(gridRows)
    .set({ cells: sql`${gridRows.cells} || ${jsonb(cells)}`, cellMeta: sql`${gridRows.cellMeta} || ${jsonb(meta)}`, updatedAt: new Date() })
    .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
}

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

async function markQueued(tx: Tx, organizationId: string, tableId: string, cells: Array<{ rowId: string; columnKey: string }>) {
  const byRow = new Map<string, Record<string, unknown>>();
  for (const c of cells) byRow.set(c.rowId, { ...(byRow.get(c.rowId) ?? {}), [c.columnKey]: { status: "queued" } });
  for (const [rowId, meta] of byRow) {
    await tx
      .update(gridRows)
      .set({ cellMeta: sql`${gridRows.cellMeta} || ${jsonb(meta)}`, updatedAt: new Date() })
      .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
  }
}

async function enqueueIn(tx: Tx, organizationId: string, tableId: string, targets: EnqueueTarget[], options: { priority: number; now: Date; fresh?: boolean }): Promise<number> {
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
async function pendingIn(tx: Tx, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(gridJobs)
    .where(and(eq(gridJobs.organizationId, organizationId), inArray(gridJobs.status, ["queued", "running", "waiting"])));
  return row?.n ?? 0;
}

async function markSkippedIn(tx: Tx, organizationId: string, tableId: string, cells: Array<{ rowId: string; columnKey: string }>, now: Date): Promise<number> {
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

/** Fences a finishing write by the lease token: a worker whose lease was taken over changes nothing. */
function fenced(job: CellJob) {
  return and(eq(gridJobs.id, job.id), eq(gridJobs.organizationId, job.organizationId), eq(gridJobs.status, "running"), eq(gridJobs.lockedAt, job.lockedAt));
}

const isoOf = (value: unknown) => new Date(String(value));

export const drizzleGridRunStore: GridRunStore = {
  async fillOutputFromLedger(organizationId, tableId, { runnerKey, outputKey, columnKey }) {
    // An answer counts only while its main value is what the row's runner cell shows, so a later run with other inputs
    // never lends an earlier answer's fields to the new column.
    const filled = await db.execute(sql`
      update grid_rows r
      set cells = r.cells || jsonb_build_object(${columnKey}::text, l.answer -> 'outputs' -> ${outputKey}::text),
          cell_meta = r.cell_meta || jsonb_build_object(${columnKey}::text, coalesce(r.cell_meta -> ${runnerKey}::text, '{}'::jsonb))
      from (
        select distinct on (row_id) row_id, answer
        from grid_cell_runs
        where organization_id = ${organizationId} and table_id = ${tableId} and column_key = ${runnerKey} and answer is not null
        order by row_id, created_at desc, id desc
      ) l
      where r.id = l.row_id and r.organization_id = ${organizationId} and r.table_id = ${tableId}
        and l.answer -> 'outputs' ? ${outputKey}::text
        and jsonb_typeof(l.answer -> 'outputs' -> ${outputKey}::text) <> 'null'
        and r.cells ->> ${runnerKey}::text = l.answer ->> 'primary'
      returning r.id
    `);
    return filled.length;
  },

  async tableAutoRun(organizationId, tableId) {
    const [row] = await db.select({ autoRun: gridTables.autoRun }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)));
    return row ? row.autoRun : null;
  },

  async listColumns(organizationId, tableId) {
    const rows = await db.select().from(gridColumns).where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId))).orderBy(asc(gridColumns.position));
    return rows.map(toColumn);
  },

  async listRows(organizationId, tableId, options) {
    const where = [eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId)];
    if (options.rowIds) {
      if (options.rowIds.length === 0) return [];
      where.push(inArray(gridRows.id, options.rowIds));
    }
    const rows = await db.select({ id: gridRows.id, cells: gridRows.cells, cellMeta: gridRows.cellMeta }).from(gridRows).where(and(...where)).orderBy(asc(gridRows.position), asc(gridRows.id)).limit(options.limit).offset(options.offset ?? 0);
    return rows;
  },

  async changeColumns(organizationId, tableId, plan) {
    try {
      return await db.transaction(async (tx) => {
        // The row lock the column store takes, so a renumber and this write take turns.
        const [locked] = await tx.select({ id: gridTables.id }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId))).for("update");
        if (!locked) return null;
        const columns = (await tx.select().from(gridColumns).where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId))).orderBy(asc(gridColumns.position), asc(gridColumns.id))).map(toColumn);
        const hasValues = async (columnKey: string) => {
          const rows = await tx.execute<{ found: boolean }>(sql`
            select exists(select 1 from grid_rows where organization_id = ${organizationId} and table_id = ${tableId}
              and cells -> ${columnKey} is not null and cells -> ${columnKey} <> 'null'::jsonb and cells -> ${columnKey} <> '""'::jsonb) as found`);
          return rows[0]?.found === true;
        };
        const change = await plan({ columns, hasValues });
        if (columns.length + change.inserts.length > GRID_LIMITS.columnsPerTable) {
          throw new ValidationError(`A table can have at most ${GRID_LIMITS.columnsPerTable} columns. This change would add ${change.inserts.length} to the ${columns.length} it has.`);
        }
        const where = (id: string) => and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId), eq(gridColumns.id, id));
        for (const move of change.renumber ?? []) await tx.update(gridColumns).set({ position: move.position, updatedAt: new Date() }).where(where(move.id));
        const updated: ColumnRow[] = [];
        for (const edit of change.updates ?? []) {
          const set: Partial<typeof gridColumns.$inferInsert> = { updatedAt: new Date() };
          if (edit.config !== undefined) set.config = edit.config;
          if (edit.dependsOn !== undefined) set.dependsOn = edit.dependsOn;
          if (edit.autoRun !== undefined) set.autoRun = edit.autoRun;
          const [row] = await tx.update(gridColumns).set(set).where(where(edit.id)).returning();
          if (row) updated.push(toColumn(row));
        }
        const inserted = change.inserts.length === 0 ? [] : (await tx.insert(gridColumns).values(change.inserts.map((c) => ({ organizationId, tableId, ...c }))).returning()).map(toColumn);
        return { inserted, updated };
      });
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505") {
        throw new ConflictError("A column with that key already exists. Try again.");
      }
      throw error;
    }
  },

  async enqueue(organizationId, tableId, targets, options) {
    if (targets.length === 0) return 0;
    return db.transaction((tx) => enqueueIn(tx, organizationId, tableId, targets, options));
  },

  async pendingCells(organizationId) {
    return pendingIn(db as unknown as Tx, organizationId);
  },

  async markSkipped(organizationId, tableId, cells, now) {
    if (cells.length === 0) return 0;
    return db.transaction((tx) => markSkippedIn(tx, organizationId, tableId, cells, now));
  },

  async cancel(organizationId, tableId) {
    return db.transaction(async (tx) => {
      const deleted = await tx
        .delete(gridJobs)
        .where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), inArray(gridJobs.status, ["queued", "waiting"])))
        .returning({ rowId: gridJobs.rowId, columnKey: gridJobs.columnKey });
      for (let i = 0; i < deleted.length; i += CHUNK) {
        await tx.insert(gridCellRuns).values(deleted.slice(i, i + CHUNK).map((d) => ({ organizationId, tableId, rowId: d.rowId, columnKey: d.columnKey, provider: null, outcome: "cancelled", costCents: "0", response: { reason: "Stopped by a person." } })));
      }
      const keysByRow = new Map<string, string[]>();
      for (const d of deleted) keysByRow.set(d.rowId, [...(keysByRow.get(d.rowId) ?? []), d.columnKey]);
      for (const [rowId, keys] of keysByRow) {
        await tx
          .update(gridRows)
          .set({ cellMeta: sql`${gridRows.cellMeta} - ${sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`}`, updatedAt: new Date() })
          .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId), eq(gridRows.id, rowId)));
      }
      return deleted.length;
    });
  },

  async retryFailed(organizationId, tableId, options) {
    return db.transaction(async (tx) => {
      const where = [eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), eq(gridJobs.status, "failed")];
      if (options.columnKey) where.push(eq(gridJobs.columnKey, options.columnKey));
      const rows = await tx
        .update(gridJobs)
        // The state of the failed tries stays, so a retry does not pay again for the steps that already missed. The
        // fresh flag goes, so the retry reuses the answers the failed run paid for, and the cell gets its free waits back.
        .set({ status: "queued", attempts: 0, error: null, providerState: requeuedState, lockedAt: null, runAfter: new Date(options.now.getTime() - DUE_SKEW_MS), updatedAt: new Date() })
        .where(and(...where))
        .returning({ rowId: gridJobs.rowId, columnKey: gridJobs.columnKey });
      await markQueued(tx, organizationId, tableId, rows);
      return rows.length;
    });
  },

  async counts(organizationId, tableId) {
    const rows = await db
      .select({ status: gridJobs.status, n: sql<number>`count(*)::int` })
      .from(gridJobs)
      .where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId)))
      .groupBy(gridJobs.status);
    const counts: JobCounts = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0 };
    for (const r of rows) if (r.status in counts) counts[r.status as keyof JobCounts] = r.n;
    return counts;
  },

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

  async providerImpact(organizationId, providerKey) {
    const columns = await db
      .select({ tableId: gridColumns.tableId, tableName: gridTables.name, columnName: gridColumns.name, key: gridColumns.key, type: gridColumns.type })
      .from(gridColumns)
      .innerJoin(gridTables, and(eq(gridTables.id, gridColumns.tableId), eq(gridTables.organizationId, gridColumns.organizationId)))
      .where(
        and(
          eq(gridColumns.organizationId, organizationId),
          inArray(gridColumns.type, ["enrichment", "waterfall"]),
          sql`(${gridColumns.config} ->> 'providerKey' = ${providerKey} or ${gridColumns.config} -> 'steps' @> ${JSON.stringify([{ providerKey }])}::jsonb)`,
        ),
      )
      .orderBy(asc(gridTables.name), asc(gridColumns.name));
    let pendingCells = 0;
    if (columns.length > 0) {
      const [row] = (await db.execute(sql`
        select count(*)::int as n from ${gridJobs}
        where organization_id = ${organizationId} and status in ('queued', 'running', 'waiting')
          and (table_id, column_key) in (${sql.join(columns.map((c) => sql`(${c.tableId}::uuid, ${c.key})`), sql`, `)})
      `)) as unknown as Array<{ n: number }>;
      pendingCells = row?.n ?? 0;
    }
    return { columns: columns.map((c) => ({ tableId: c.tableId, tableName: c.tableName, columnName: c.columnName, waterfall: c.type === "waterfall" })), pendingCells };
  },

  async providerUsage(organizationId, since) {
    const rows = (await db.execute(sql`
      select provider,
        count(*) filter (where not reused and outcome in ('hit', 'miss', 'error'))::int as calls,
        count(*) filter (where not reused and outcome = 'hit')::int as hits,
        count(*) filter (where not reused and outcome = 'miss')::int as misses,
        count(*) filter (where outcome = 'error')::int as errors,
        count(*) filter (where reused)::int as reused,
        coalesce(sum(credits), 0)::float as credits,
        coalesce(sum(cost_cents), 0)::float as cost_cents,
        percentile_cont(0.5) within group (order by latency_ms) filter (where not reused and latency_ms is not null) as p50
      from ${gridCellRuns}
      where organization_id = ${organizationId} and provider is not null and created_at > ${since.toISOString()}::timestamptz
      group by provider
      order by provider
    `)) as unknown as Array<{ provider: string; calls: number; hits: number; misses: number; errors: number; reused: number; credits: number; cost_cents: number; p50: number | null }>;
    return rows.map((r) => ({
      provider: r.provider,
      calls: r.calls,
      hits: r.hits,
      misses: r.misses,
      errors: r.errors,
      reused: r.reused,
      credits: r.credits,
      costCents: r.cost_cents,
      p50LatencyMs: r.p50 === null ? null : Math.round(Number(r.p50)),
    }));
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

  async cellRuns(organizationId, tableId, rowId, columnKey, limit) {
    const rows = await db
      .select()
      .from(gridCellRuns)
      .where(and(eq(gridCellRuns.organizationId, organizationId), eq(gridCellRuns.tableId, tableId), eq(gridCellRuns.rowId, rowId), eq(gridCellRuns.columnKey, columnKey)))
      .orderBy(desc(gridCellRuns.createdAt))
      .limit(limit);
    return rows.map((r) => ({ id: r.id, provider: r.provider, outcome: r.outcome, costCents: Number(r.costCents), credits: r.credits === null ? null : Number(r.credits), reused: r.reused, latencyMs: r.latencyMs, request: r.request, response: r.response, createdAt: r.createdAt }));
  },
};
