import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ConflictError, ValidationError } from "@/shared/errors";
import { db, type DbTx } from "@/platform/db/client";
import { gridCellRuns, gridColumns, gridJobs, gridRows, gridTables } from "@/platform/db/schema";
import { GRID_LIMITS } from "../../application/limits";
import type { ColumnRow, GridRunStore, JobCounts } from "../application/enrichment-ports";
import { CHUNK, DUE_SKEW_MS, enqueueIn, markQueued, markSkippedIn, pendingIn, requeuedState, toColumn } from "./enrichment-store-shared";

type Tx = DbTx;

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
