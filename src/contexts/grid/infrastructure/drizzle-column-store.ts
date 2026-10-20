import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { gridColumns, gridJobs, gridRows, gridTables } from "@/platform/db/schema";
import type { ColumnInsert, ColumnRecord, ColumnRenumber, ColumnStore } from "../application/ports";
import type { ColumnType } from "../domain/column-types";
import { patchCells, textArray, type Tx } from "./row-sql";

export const asColumn = (row: typeof gridColumns.$inferSelect): ColumnRecord => ({
  id: row.id,
  tableId: row.tableId,
  key: row.key,
  name: row.name,
  type: row.type as ColumnType,
  config: row.config,
  dependsOn: row.dependsOn,
  position: row.position,
  autoRun: row.autoRun,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Locks the table row, so two column writes in one table take turns. Returns the saved view, or null for another tenant's table. */
export async function lockTable(tx: Tx, organizationId: string, tableId: string): Promise<{ view: Record<string, unknown> } | null> {
  const [row] = await tx
    .select({ view: gridTables.view })
    .from(gridTables)
    .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)))
    .for("update");
  return row ?? null;
}

export async function listIn(tx: Pick<Tx, "select">, organizationId: string, tableId: string): Promise<ColumnRecord[]> {
  const rows = await tx
    .select()
    .from(gridColumns)
    .where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId)))
    .orderBy(asc(gridColumns.position), asc(gridColumns.id));
  return rows.map(asColumn);
}

export const insertValues = (organizationId: string, tableId: string, c: ColumnInsert) => ({
  organizationId,
  tableId,
  key: c.key,
  name: c.name,
  type: c.type,
  config: c.config,
  dependsOn: c.dependsOn,
  position: c.position,
  autoRun: c.autoRun,
});

/** Moves siblings to make room for a column. The caller holds the table lock. */
export async function renumber(tx: Tx, organizationId: string, tableId: string, moves: ColumnRenumber[] | undefined): Promise<void> {
  for (const move of moves ?? []) {
    await tx
      .update(gridColumns)
      .set({ position: move.position, updatedAt: new Date() })
      .where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId), eq(gridColumns.id, move.id)));
  }
}

export const drizzleColumnStore: ColumnStore = {
  list: (organizationId, tableId) => listIn(db, organizationId, tableId),

  async create(organizationId, tableId, plan) {
    return db.transaction(async (tx) => {
      if (!(await lockTable(tx, organizationId, tableId))) return null;
      const insert = plan(await listIn(tx, organizationId, tableId));
      await renumber(tx, organizationId, tableId, insert.renumber);
      const [row] = await tx.insert(gridColumns).values(insertValues(organizationId, tableId, insert)).returning();
      if (insert.copyValuesFrom) {
        await tx.execute(sql`
          update grid_rows set cells = jsonb_set(cells, ARRAY[${insert.key}]::text[], cells -> ${insert.copyValuesFrom}), updated_at = now()
          where table_id = ${tableId} and organization_id = ${organizationId} and cells -> ${insert.copyValuesFrom} is not null`);
      }
      return asColumn(row);
    });
  },

  async update(organizationId, tableId, columnId, plan) {
    return db.transaction(async (tx) => {
      if (!(await lockTable(tx, organizationId, tableId))) return null;
      const all = await listIn(tx, organizationId, tableId);
      const current = all.find((c) => c.id === columnId);
      if (!current) return null;
      const change = plan(current, all);
      await renumber(tx, organizationId, tableId, change.renumber);

      if (change.convertValues) {
        const rows = await tx.execute<{ id: string; value: unknown }>(sql`
          select id, cells -> ${current.key} as value from grid_rows
          where table_id = ${tableId} and organization_id = ${organizationId} and cells -> ${current.key} is not null for update`);
        const patches: Array<{ rowId: string; patch: Record<string, unknown> }> = [];
        for (const row of rows) {
          const after = change.convertValues(row.value) ?? null;
          if (JSON.stringify(after) !== JSON.stringify(row.value ?? null)) patches.push({ rowId: row.id, patch: { [current.key]: after } });
        }
        await patchCells(tx, organizationId, tableId, patches);
      }
      if (change.dropJobs) {
        await tx.delete(gridJobs).where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), eq(gridJobs.columnKey, current.key)));
      }

      const values: Partial<typeof gridColumns.$inferInsert> = { updatedAt: new Date() };
      if (change.name !== undefined) values.name = change.name;
      if (change.type !== undefined) values.type = change.type;
      if (change.config !== undefined) values.config = change.config;
      if (change.dependsOn !== undefined) values.dependsOn = change.dependsOn;
      if (change.position !== undefined) values.position = change.position;
      if (change.autoRun !== undefined) values.autoRun = change.autoRun;
      const [row] = await tx.update(gridColumns).set(values).where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.id, columnId))).returning();
      return asColumn(row);
    });
  },

  async remove(organizationId, tableId, columnId, plan) {
    return db.transaction(async (tx) => {
      const table = await lockTable(tx, organizationId, tableId);
      if (!table) return null;
      const all = await listIn(tx, organizationId, tableId);
      const column = all.find((c) => c.id === columnId);
      if (!column) return null;
      const decision = plan(column, all, table.view);
      const doomed = all.filter((c) => decision.deleteIds.includes(c.id));
      const keys = doomed.map((c) => c.key);

      await tx.delete(gridColumns).where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.tableId, tableId), inArray(gridColumns.id, decision.deleteIds)));
      await tx.delete(gridJobs).where(and(eq(gridJobs.organizationId, organizationId), eq(gridJobs.tableId, tableId), inArray(gridJobs.columnKey, keys)));
      for (const update of decision.configUpdates) {
        await tx
          .update(gridColumns)
          .set({ config: update.config, ...(update.dependsOn ? { dependsOn: update.dependsOn } : {}), updatedAt: new Date() })
          .where(and(eq(gridColumns.organizationId, organizationId), eq(gridColumns.id, update.id)));
      }
      await tx
        .update(gridTables)
        .set({ view: decision.view as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)));
      // Strip the keys from every row. A column created later with the same key must not inherit the old values.
      await tx
        .update(gridRows)
        .set({ cells: sql`${gridRows.cells} - ${textArray(keys)}`, cellMeta: sql`${gridRows.cellMeta} - ${textArray(keys)}`, updatedAt: new Date() })
        .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId)));
      return { deletedIds: doomed.map((c) => c.id) };
    });
  },

  async splitText(organizationId, tableId, columnId, plan) {
    return db.transaction(async (tx) => {
      if (!(await lockTable(tx, organizationId, tableId))) return null;
      const all = await listIn(tx, organizationId, tableId);
      const source = all.find((c) => c.id === columnId);
      if (!source) return null;
      const rows = await tx
        .select({ id: gridRows.id, cells: gridRows.cells })
        .from(gridRows)
        .where(and(eq(gridRows.organizationId, organizationId), eq(gridRows.tableId, tableId)))
        .orderBy(asc(gridRows.position), asc(gridRows.id))
        .for("update");
      const { columns, patches } = plan(source, all, rows);
      const created = await tx
        .insert(gridColumns)
        .values(columns.map((c) => insertValues(organizationId, tableId, c)))
        .returning();
      const rowsUpdated = await patchCells(tx, organizationId, tableId, patches);
      return { columns: created.map(asColumn), rowsUpdated };
    });
  },
};
