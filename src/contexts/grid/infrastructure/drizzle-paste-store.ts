import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { gridColumns, gridRows } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { ColumnRecord, PasteRequest, PasteResult, PasteWrite } from "../application/ports";
import { placeAfter, uniqueColumnKey, uniqueColumnName } from "../domain/keys";
import { asColumn, insertValues, listIn, lockTable, renumber } from "./drizzle-column-store";
import { asRow, patchCells } from "./row-sql";

const INSERT_CHUNK = 500;

/**
 * Pastes a block in one transaction. The table row lock comes first, as in drizzle-column-store.ts, so a column
 * change, an import and a second paste take turns. Rows are then locked in id order (the order `applyEdits`
 * uses), never in table order, so two writers cannot wait on each other.
 */
export async function pasteBlock(
  organizationId: string,
  tableId: string,
  request: PasteRequest,
  build: (current: { columns: ColumnRecord[]; created: ColumnRecord[]; foundRows: number }) => PasteWrite,
): Promise<PasteResult | null> {
  return db.transaction(async (tx) => {
    if (!(await lockTable(tx, organizationId, tableId))) return null;
    const inTable = and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId));

    let columns = await listIn(tx, organizationId, tableId);
    const known = new Set(columns.map((c) => c.key));
    if (request.columnKeys.some((key) => !known.has(key))) throw new ConflictError("A column you pasted into was removed. Reload the table and paste again.");
    if (columns.length + request.newColumns > request.limits.maxColumns) throw new ConflictError(`A table can have at most ${request.limits.maxColumns} columns.`);

    // The anchor and the rows after it, in table order. Rows the client never loaded count the same as loaded ones.
    const [anchor] = await tx.select({ id: gridRows.id, position: gridRows.position }).from(gridRows).where(and(inTable, eq(gridRows.id, request.anchorRowId)));
    if (!anchor) throw new NotFoundError("The row you pasted into no longer exists.");
    const ordered = await tx
      .select({ id: gridRows.id })
      .from(gridRows)
      .where(and(inTable, sql`(${gridRows.position}, ${gridRows.id}) >= (${anchor.position}, ${anchor.id}::uuid)`))
      .orderBy(asc(gridRows.position), asc(gridRows.id))
      .limit(request.height);
    const foundIds = ordered.map((r) => r.id);
    const locked = foundIds.length === 0 ? [] : await tx.select().from(gridRows).where(and(inTable, inArray(gridRows.id, foundIds))).orderBy(asc(gridRows.id)).for("update");
    if (locked.length !== foundIds.length) throw new ConflictError("A row changed while you pasted. Try again.");
    const lockedById = new Map(locked.map((r) => [r.id, r]));

    const addRows = request.height - foundIds.length;
    if (addRows > request.limits.maxNewRows) throw new ValidationError(`A paste can add up to ${request.limits.maxNewRows.toLocaleString("en-US")} rows.`);
    if (addRows > 0) {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(gridRows).where(inTable);
      if (count + addRows > request.limits.maxRows) throw new ConflictError(`A table can hold at most ${request.limits.maxRows.toLocaleString("en-US")} rows.`);
    }

    // New columns go after the last column of the block, one after the other, each renumbering under the lock when the gap is gone.
    const created: ColumnRecord[] = [];
    let anchorKey = request.columnKeys[request.columnKeys.length - 1];
    for (let i = 0; i < request.newColumns; i++) {
      const name = uniqueColumnName(`Column ${columns.length + 1}`, columns.map((c) => c.name));
      const key = uniqueColumnKey(name, new Set(columns.map((c) => c.key)));
      const placement = placeAfter(columns, columns.find((c) => c.key === anchorKey)?.id);
      await renumber(tx, organizationId, tableId, placement.renumber);
      const [row] = await tx
        .insert(gridColumns)
        .values(insertValues(organizationId, tableId, { key, name, type: "text", config: {}, dependsOn: [], position: placement.position, autoRun: true }))
        .returning();
      created.push(asColumn(row));
      anchorKey = key;
      columns = await listIn(tx, organizationId, tableId);
    }

    const write = build({ columns, created, foundRows: foundIds.length });

    const newIds: string[] = [];
    if (addRows > 0) {
      const [{ top }] = await tx.select({ top: sql<number>`coalesce(max(${gridRows.position}), 0)` }).from(gridRows).where(inTable);
      for (let offset = 0; offset < addRows; offset += INSERT_CHUNK) {
        const size = Math.min(INSERT_CHUNK, addRows - offset);
        const inserted = await tx
          .insert(gridRows)
          .values(Array.from({ length: size }, (_, i) => ({ organizationId, tableId, position: Number(top) + offset + i + 1, cells: {}, cellMeta: {} })))
          .returning({ id: gridRows.id, position: gridRows.position });
        newIds.push(...inserted.sort((a, b) => a.position - b.position).map((r) => r.id));
      }
    }
    const rowIds = [...foundIds, ...newIds];

    const patches = new Map<string, Record<string, unknown>>();
    for (const cell of write.cells) {
      const rowId = rowIds[cell.rowIndex];
      if (!rowId) continue;
      patches.set(rowId, { ...patches.get(rowId), [cell.columnKey]: cell.value });
    }
    await patchCells(tx, organizationId, tableId, [...patches].map(([rowId, patch]) => ({ rowId, patch })));

    const updated = rowIds.length === 0 ? [] : await tx.select().from(gridRows).where(and(inTable, inArray(gridRows.id, rowIds)));
    const byId = new Map(updated.map((r) => [r.id, r]));
    return {
      rowIds,
      previous: new Map([...lockedById].map(([id, r]) => [id, r.cells] as const).concat(newIds.map((id) => [id, {}] as const))),
      addedRows: newIds.length,
      createdColumns: created,
      rows: rowIds.map((id) => asRow(byId.get(id)!)),
    };
  });
}

export const drizzlePasteStore = { paste: pasteBlock };
