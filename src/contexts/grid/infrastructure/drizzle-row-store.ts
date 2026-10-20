import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { gridColumns, gridJobs, gridRows, gridTables } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { CellEdit, ColumnRecord, RowRecord, RowStore, SkippedCell } from "../application/ports";
import { sameCellValue } from "../domain/cell-compare";
import { isInitialPlaceholderRow, isInitialSeedColumn } from "../domain/import-plan";
import { formatChangeCursor, parseChangeCursor } from "../domain/change-cursor";
import { RowConflictError, type RowConflict } from "../domain/row-conflict";
import { drizzleColumnStore } from "./drizzle-column-store";
import { pasteBlock } from "./drizzle-paste-store";
import { asRow, mergeEdits, patchCells, type Tx } from "./row-sql";
import { buildOrderBy, buildWhere } from "./view-sql";

/**
 * The changes feed (see domain/change-cursor.ts for the cursor). A version comes from nextval() when a
 * statement runs, but its row is visible only when the transaction commits, so version 101 can appear
 * after 102 and a strict `> cursor` would skip it for good. Every row carries the id of the transaction
 * that wrote it (xmin), and pg_snapshot_xmin() is the oldest transaction still running. Each round
 * reads rows above the cursor version plus every row written by a transaction at or after the previous
 * round's horizon, so a late commit is read again however many versions went past, with no clock and
 * no overlap window. A round that has more than `limit` rows pages forward and keeps its horizon, and
 * the cursor settles only on the last page. A row read twice is harmless, the client overwrites by id.
 * The cost is that an idle transaction held open for a long time keeps the horizon low, so rows written
 * since it started are sent again on each poll until it ends.
 */
const ID_CHUNK = 5_000;
const INSERT_CHUNK = 500;

/** xid is 32 bits in a tuple header and the horizon is 64 bits, so compare modulo 2^32 the way Postgres does. */
const XID_SPACE = 4_294_967_296;

/** The oldest transaction id still running, or the next one to be assigned when none is. */
async function snapshotHorizon(): Promise<number> {
  const rows = await db.execute<{ x: string }>(sql`select pg_snapshot_xmin(pg_current_snapshot())::text as x`);
  return Number(rows[0].x);
}

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const inTable = (organizationId: string, tableId: string) => and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId));

async function lockTable(tx: Tx, organizationId: string, tableId: string): Promise<boolean> {
  const [row] = await tx.select({ id: gridTables.id }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId))).for("update");
  return Boolean(row);
}

async function rowCount(tx: Pick<Tx, "select">, organizationId: string, tableId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(gridRows).where(inTable(organizationId, tableId));
  return row?.n ?? 0;
}

async function maxPosition(tx: Pick<Tx, "select">, organizationId: string, tableId: string): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${gridRows.position})` }).from(gridRows).where(inTable(organizationId, tableId));
  return row?.max ?? 0;
}

export const drizzleRowStore: RowStore = {
  async list(organizationId, tableId, input) {
    const extra = buildWhere(input.query, input.columns);
    const rows = await db
      .select()
      .from(gridRows)
      .where(extra ? and(inTable(organizationId, tableId), extra) : inTable(organizationId, tableId))
      .orderBy(buildOrderBy(input.query?.sorts, input.columns))
      .limit(input.limit)
      .offset(input.offset);
    return rows.map(asRow);
  },

  async listByIds(organizationId, tableId, ids) {
    const out: RowRecord[] = [];
    for (const part of chunked([...new Set(ids)], ID_CHUNK)) {
      const rows = await db.select().from(gridRows).where(and(inTable(organizationId, tableId), inArray(gridRows.id, part)));
      out.push(...rows.map(asRow));
    }
    return out.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  },

  async countByIds(organizationId, tableId, ids) {
    let total = 0;
    for (const part of chunked([...new Set(ids)], ID_CHUNK)) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(gridRows).where(and(inTable(organizationId, tableId), inArray(gridRows.id, part)));
      total += row?.n ?? 0;
    }
    return total;
  },

  async listIds(organizationId, tableId, input) {
    const extra = buildWhere(input.query, input.columns);
    const rows = await db
      .select({ id: gridRows.id })
      .from(gridRows)
      .where(extra ? and(inTable(organizationId, tableId), extra) : inTable(organizationId, tableId))
      .orderBy(buildOrderBy(input.query?.sorts, input.columns))
      .limit(input.limit);
    return rows.map((r) => r.id);
  },

  async count(organizationId, tableId, input) {
    const extra = buildWhere(input?.query, input?.columns ?? []);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gridRows)
      .where(extra ? and(inTable(organizationId, tableId), extra) : inTable(organizationId, tableId));
    return row?.n ?? 0;
  },

  async currentVersion(organizationId, tableId) {
    const [row] = await db.select({ max: sql<string | null>`max(${gridRows.version})` }).from(gridRows).where(inTable(organizationId, tableId));
    return Number(row?.max ?? 0);
  },

  async activeJobs(organizationId, tableId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gridJobs)
      .where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), inArray(gridJobs.status, ["queued", "running", "waiting"])));
    return row?.n ?? 0;
  },

  async currentCursor(organizationId, tableId) {
    // The horizon is read before the version: a lower horizon only re-reads more, so it is the safe order.
    const watermark = await snapshotHorizon();
    const version = await drizzleRowStore.currentVersion(organizationId, tableId);
    return formatChangeCursor({ version, watermark, after: version, next: null });
  },

  async changesSince(organizationId, tableId, cursorText, limit) {
    const cursor = parseChangeCursor(cursorText);
    if (!cursor) throw new ValidationError("cursor is not a cursor this table gave out");
    const horizon = await snapshotHorizon();
    // A bare version from an older client has no horizon. It gets the current one, which has no late-commit protection.
    const watermark = cursor.watermark ?? horizon;
    const next = cursor.next ?? horizon;
    const paging = cursor.next !== null;
    const writtenSince = sql`(("grid_rows"."xmin"::text::bigint - ${watermark % XID_SPACE} + ${XID_SPACE}) % ${XID_SPACE}) < ${XID_SPACE / 2}`;
    const [activeJobs, total, found] = await Promise.all([
      drizzleRowStore.activeJobs(organizationId, tableId),
      drizzleRowStore.count(organizationId, tableId),
      db
        .select()
        .from(gridRows)
        .where(and(inTable(organizationId, tableId), or(gt(gridRows.version, cursor.version), writtenSince), paging ? gt(gridRows.version, cursor.after) : undefined))
        .orderBy(asc(gridRows.version))
        .limit(limit + 1),
    ]);
    const hasMore = found.length > limit;
    const records = found.slice(0, limit).map(asRow);
    const last = records.length > 0 ? records[records.length - 1].version : cursor.after;
    if (hasMore) return { rows: records, cursor: formatChangeCursor({ version: cursor.version, watermark, after: last, next }), hasMore, total, activeJobs };
    const settled = Math.max(cursor.version, cursor.after, last);
    return { rows: records, cursor: formatChangeCursor({ version: settled, watermark: next, after: settled, next: null }), hasMore, total, activeJobs };
  },

  async addBlank(organizationId, tableId, count, maxRows) {
    return db.transaction(async (tx) => {
      if (!(await lockTable(tx, organizationId, tableId))) throw new NotFoundError("Table not found");
      const existing = await rowCount(tx, organizationId, tableId);
      if (existing + count > maxRows) throw new ConflictError(`A table can hold at most ${maxRows.toLocaleString("en-US")} rows.`);
      const start = await maxPosition(tx, organizationId, tableId);
      const rows = await tx
        .insert(gridRows)
        .values(Array.from({ length: count }, (_, i) => ({ organizationId, tableId, position: start + i + 1, cells: {}, cellMeta: {} })))
        .returning();
      return rows.map(asRow);
    });
  },

  async applyEdits(organizationId, tableId, input: CellEdit[]) {
    // One edit per row: the version check and the patch both need a single answer for each row.
    const edits = mergeEdits(input);
    return db.transaction(async (tx) => {
      const ids = edits.map((e) => e.rowId);
      // A stable lock order keeps two overlapping pastes dragged in opposite directions from deadlocking.
      const locked = await tx
        .select({ id: gridRows.id, cells: gridRows.cells, version: gridRows.version })
        .from(gridRows)
        .where(and(inTable(organizationId, tableId), inArray(gridRows.id, ids)))
        .orderBy(asc(gridRows.id))
        .for("update");
      const byId = new Map(locked.map((r) => [r.id, r]));

      const conflicts: RowConflict[] = [];
      const skipped: SkippedCell[] = [];
      const writes: CellEdit[] = [];
      for (const edit of edits) {
        const current = byId.get(edit.rowId);
        if (!current) {
          // A row that is gone (deleted by someone else) skips the cells that asked for a compare-and-set.
          if (edit.expected && Object.keys(edit.set).every((key) => key in edit.expected!)) {
            for (const key of Object.keys(edit.set)) skipped.push({ rowId: edit.rowId, columnKey: key, current: null });
            continue;
          }
          if (edit.expectedVersion !== undefined) conflicts.push({ rowId: edit.rowId, expectedVersion: edit.expectedVersion, currentVersion: null, cells: null });
          else throw new NotFoundError("One or more rows were not found in this table");
          continue;
        }
        if (edit.expectedVersion !== undefined && Number(current.version) !== edit.expectedVersion) {
          conflicts.push({ rowId: edit.rowId, expectedVersion: edit.expectedVersion, currentVersion: Number(current.version), cells: current.cells });
          continue;
        }
        const set: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(edit.set)) {
          if (edit.expected && key in edit.expected && !sameCellValue(current.cells[key], edit.expected[key])) skipped.push({ rowId: edit.rowId, columnKey: key, current: current.cells[key] ?? null });
          else set[key] = value;
        }
        if (Object.keys(set).length > 0 || edit.meta) writes.push({ ...edit, set });
      }
      // Nothing is written when any row is stale: a partial paste would leave the grid in a state nobody chose.
      if (conflicts.length > 0) throw new RowConflictError(conflicts);

      await patchCells(tx, organizationId, tableId, writes.map((e) => ({ rowId: e.rowId, patch: e.set, meta: e.meta })));
      const updated = await tx.select().from(gridRows).where(and(inTable(organizationId, tableId), inArray(gridRows.id, ids)));
      return {
        rows: updated.map(asRow),
        previous: new Map(locked.map((r) => [r.id, r.cells])),
        skipped,
      };
    });
  },

  paste: pasteBlock,

  async markStale(organizationId, tableId, columnKeys, reason, rowIds) {
    let rows = 0;
    for (const key of columnKeys) {
      const entry = JSON.stringify({ [key]: { status: "stale", error: reason } });
      const changed = await db
        .update(gridRows)
        .set({ cellMeta: sql`${gridRows.cellMeta} || ${entry}::jsonb`, updatedAt: new Date() })
        .where(and(inTable(organizationId, tableId), sql`coalesce(${gridRows.cellMeta} -> ${key} ->> 'status', '') <> 'stale'`, rowIds ? inArray(gridRows.id, rowIds) : undefined))
        .returning({ id: gridRows.id });
      rows = Math.max(rows, changed.length);
    }
    return rows;
  },

  async delete(organizationId, tableId, ids) {
    const deleted = await db.delete(gridRows).where(and(inTable(organizationId, tableId), inArray(gridRows.id, ids))).returning({ id: gridRows.id });
    return deleted.length;
  },

  async importRecords(organizationId, tableId, build, limits) {
    return db.transaction(async (tx) => {
      if (!(await lockTable(tx, organizationId, tableId))) return null;
      const columns = await drizzleColumnStore.list(organizationId, tableId);
      const firstRows = await tx
        .select({ id: gridRows.id, cells: gridRows.cells, cellMeta: gridRows.cellMeta })
        .from(gridRows)
        .where(inTable(organizationId, tableId))
        .orderBy(asc(gridRows.position), asc(gridRows.id))
        .limit(2);
      const placeholder = isInitialPlaceholderRow(firstRows) ? firstRows[0] : null;

      const write = build({ columns: columns as ColumnRecord[], canReuseSeed: placeholder !== null && isInitialSeedColumn(columns) });
      const created = write.newColumns.filter((c) => !c.reuseExisting).length;
      if (columns.length + created > limits.maxColumns) throw new ConflictError(`A table can have at most ${limits.maxColumns} columns.`);
      const existing = await rowCount(tx, organizationId, tableId);
      if (existing + write.records.length > limits.maxRows) throw new ConflictError(`A table can hold at most ${limits.maxRows.toLocaleString("en-US")} rows. Delete rows or import into another table.`);

      let position = columns.reduce((max, c) => Math.max(max, c.position), 0);
      for (const column of write.newColumns) {
        if (column.reuseExisting) {
          await tx
            .update(gridColumns)
            .set({ key: column.key, name: column.name, type: column.type, updatedAt: new Date() })
            .where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId), eq(gridColumns.key, column.replacesKey ?? column.key)));
        } else {
          position += 1;
          await tx.insert(gridColumns).values({ organizationId, tableId, key: column.key, name: column.name, type: column.type, config: {}, dependsOn: [], position });
        }
      }

      const start = await maxPosition(tx, organizationId, tableId);
      let inserted = 0;
      for (const part of chunked(write.records, INSERT_CHUNK)) {
        await tx.insert(gridRows).values(part.map((cells, j) => ({ organizationId, tableId, position: start + inserted + j + 1, cells, cellMeta: {} })));
        inserted += part.length;
      }
      // Insert first, delete second, so a failed import leaves a fresh table usable. The cells re-check guards a race with an editor.
      if (inserted > 0 && placeholder) {
        await tx.delete(gridRows).where(and(inTable(organizationId, tableId), eq(gridRows.id, placeholder.id), sql`${gridRows.cells} = '{}'::jsonb`, sql`${gridRows.cellMeta} = '{}'::jsonb`));
      }
      return { rowsInserted: inserted, columnsCreated: write.newColumns.length };
    });
  },

  scan(organizationId, tableId, input) {
    const columns = input.columns ?? [];
    const filter = buildWhere(input.query, columns);
    const sorted = (input.query?.sorts ?? []).some((s) => columns.some((c) => c.key === s.columnKey));
    const base = filter ? and(inTable(organizationId, tableId), filter) : inTable(organizationId, tableId);
    return {
      async *[Symbol.asyncIterator]() {
        // A sort by cell value has no keyset, so it pages by offset over the same ORDER BY the grid uses.
        // Table order keeps the keyset scan, which stays cheap however deep the table goes.
        let last: { position: number; id: string } | null = null;
        let offset = 0;
        for (;;) {
          const rows: Array<typeof gridRows.$inferSelect> = sorted
            ? await db.select().from(gridRows).where(base).orderBy(buildOrderBy(input.query?.sorts, columns)).limit(input.batch).offset(offset)
            : await db
                .select()
                .from(gridRows)
                .where(last ? and(base, sql`(${gridRows.position}, ${gridRows.id}) > (${last.position}, ${last.id}::uuid)`) : base)
                .orderBy(asc(gridRows.position), asc(gridRows.id))
                .limit(input.batch);
          if (rows.length === 0) return;
          yield rows.map(asRow);
          if (rows.length < input.batch) return;
          const tail: typeof gridRows.$inferSelect = rows[rows.length - 1];
          last = { position: tail.position, id: tail.id };
          offset += rows.length;
        }
      },
    };
  },

  async deleteDuplicates(organizationId, tableId, columnId, pick) {
    return db.transaction(async (tx) => {
      // Table lock first, then rows: the order paste and the column store use. Locking the column before the rows
      // could wait on a paste that holds the rows and wants the column (40P01).
      if (!(await lockTable(tx, organizationId, tableId))) return null;
      const [column] = await tx
        .select()
        .from(gridColumns)
        .where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId), eq(gridColumns.id, columnId)));
      if (!column) return null;
      const rows = await tx
        .select({ id: gridRows.id, cells: gridRows.cells })
        .from(gridRows)
        .where(inTable(organizationId, tableId))
        .orderBy(asc(gridRows.position), asc(gridRows.id))
        .for("update");
      const ids = pick(rows, column as unknown as ColumnRecord);
      let deleted = 0;
      for (const part of chunked(ids, ID_CHUNK)) {
        const removed = await tx.delete(gridRows).where(and(inTable(organizationId, tableId), inArray(gridRows.id, part))).returning({ id: gridRows.id });
        deleted += removed.length;
      }
      return deleted;
    });
  },
};
