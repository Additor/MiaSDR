import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { gridColumns, gridFolders, gridRows, gridTables, gridUserViews, gridWorkbooks } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import { placeAfter } from "../domain/keys";
import type { TableView } from "../domain/view-query";
import type { FolderRecord, StructureStore, TableRecord, WorkbookRecord } from "../application/ports";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const asTable = (row: typeof gridTables.$inferSelect): TableRecord => ({
  id: row.id,
  workbookId: row.workbookId,
  name: row.name,
  description: row.description,
  autoRun: row.autoRun,
  position: row.position,
  view: row.view,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const asFolder = (row: typeof gridFolders.$inferSelect): FolderRecord => ({ id: row.id, name: row.name, parentId: row.parentId, createdAt: row.createdAt, updatedAt: row.updatedAt });

const asWorkbook = (row: typeof gridWorkbooks.$inferSelect): WorkbookRecord => ({
  id: row.id,
  folderId: row.folderId,
  name: row.name,
  description: row.description,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The folder and every folder below it, with depth (0 is the folder itself). */
async function subtree(tx: Pick<Tx, "execute">, organizationId: string, id: string): Promise<Array<{ id: string; depth: number }>> {
  const rows = await tx.execute<{ id: string; depth: number }>(sql`
    with recursive tree as (
      select f.id, 0 as depth from grid_folders f where f.id = ${id} and f.organization_id = ${organizationId}
      union all
      select c.id, tree.depth + 1 from grid_folders c join tree on c.parent_id = tree.id where c.organization_id = ${organizationId}
    )
    select id, depth from tree`);
  return [...rows].map((r) => ({ id: r.id, depth: Number(r.depth) }));
}

/** Locks the workbook row so two writers cannot both see room for one more table or both empty the workbook. */
async function lockWorkbook(tx: Tx, organizationId: string, workbookId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: gridWorkbooks.id })
    .from(gridWorkbooks)
    .where(and(eq(gridWorkbooks.organizationId, organizationId), eq(gridWorkbooks.id, workbookId)))
    .for("update");
  return Boolean(row);
}

async function tableCount(tx: Tx, organizationId: string, workbookId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(gridTables)
    .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId)));
  return row?.n ?? 0;
}

async function maxPosition(tx: Tx, organizationId: string, workbookId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${gridTables.position})` })
    .from(gridTables)
    .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId)));
  return row?.max ?? 0;
}

/** A new table starts with one text column and one empty row, so the grid is never a dead end. */
async function seedTable(tx: Tx, organizationId: string, tableId: string): Promise<void> {
  await tx.insert(gridColumns).values({ organizationId, tableId, key: "name", name: "New Column", type: "text", config: {}, dependsOn: [], position: 1 });
  await tx.insert(gridRows).values({ organizationId, tableId, position: 1, cells: {}, cellMeta: {} });
}

export const drizzleStructureStore: StructureStore = {
  /* ---------------------------------------------------------------- folders */

  async listFolders(organizationId, parentId) {
    const rows = await db.execute<{ id: string; name: string; parent_id: string | null; created_at: Date; updated_at: Date; folder_count: number; workbook_count: number }>(sql`
      select f.id, f.name, f.parent_id, f.created_at, f.updated_at,
        (select count(*)::int from grid_folders c where c.parent_id = f.id and c.organization_id = f.organization_id) as folder_count,
        (select count(*)::int from grid_workbooks w where w.folder_id = f.id and w.organization_id = f.organization_id) as workbook_count
      from grid_folders f
      where f.organization_id = ${organizationId} and f.parent_id is not distinct from ${parentId}::uuid
      order by f.name, f.id`);
    return [...rows].map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      folderCount: Number(r.folder_count),
      workbookCount: Number(r.workbook_count),
    }));
  },

  async listAllFolders(organizationId) {
    const rows = await db.select().from(gridFolders).where(eq(gridFolders.organizationId, organizationId)).orderBy(asc(gridFolders.name), asc(gridFolders.id));
    return rows.map(asFolder);
  },

  async getFolder(organizationId, id) {
    const [row] = await db.select().from(gridFolders).where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, id)));
    return row ? asFolder(row) : null;
  },

  async folderPath(organizationId, id) {
    const rows = await db.execute<{ id: string; name: string }>(sql`
      with recursive trail as (
        select f.id, f.name, f.parent_id, 0 as depth from grid_folders f where f.id = ${id} and f.organization_id = ${organizationId}
        union all
        select p.id, p.name, p.parent_id, trail.depth + 1 from grid_folders p join trail on p.id = trail.parent_id where p.organization_id = ${organizationId}
      )
      select id, name from trail order by depth desc`);
    return [...rows].map((r) => ({ id: r.id, name: r.name }));
  },

  async createFolder(organizationId, input) {
    if (input.parentId && !(await drizzleStructureStore.getFolder(organizationId, input.parentId))) throw new NotFoundError("Parent folder not found");
    const [row] = await db.insert(gridFolders).values({ organizationId, name: input.name, parentId: input.parentId }).returning();
    return asFolder(row);
  },

  async updateFolder(organizationId, id, patch) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(gridFolders)
        .where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, id)))
        .for("update");
      if (!current) return null;
      const values: Partial<typeof gridFolders.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.parentId !== undefined) {
        if (patch.parentId !== null) {
          // Moving a folder inside itself or one of its own subfolders would cut the subtree off from the root.
          if ((await subtree(tx, organizationId, id)).some((f) => f.id === patch.parentId)) throw new ValidationError("A folder cannot be moved inside itself");
          const [parent] = await tx.select({ id: gridFolders.id }).from(gridFolders).where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, patch.parentId)));
          if (!parent) throw new NotFoundError("Destination folder not found");
        }
        values.parentId = patch.parentId;
      }
      const [row] = await tx.update(gridFolders).set(values).where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, id))).returning();
      return asFolder(row);
    });
  },

  async deleteFolder(organizationId, id) {
    return db.transaction(async (tx) => {
      const tree = await subtree(tx, organizationId, id);
      if (tree.length === 0) return { deleted: false, released: 0 };
      const ids = tree.map((f) => f.id);
      const released = await tx
        .update(gridWorkbooks)
        .set({ folderId: null, updatedAt: new Date() })
        .where(and(eq(gridWorkbooks.organizationId, organizationId), inArray(gridWorkbooks.folderId, ids)))
        .returning({ id: gridWorkbooks.id });
      // The parent foreign key restricts, so children go first, one level at a time.
      const deepest = Math.max(...tree.map((f) => f.depth));
      for (let depth = deepest; depth >= 0; depth -= 1) {
        const level = tree.filter((f) => f.depth === depth).map((f) => f.id);
        await tx.delete(gridFolders).where(and(eq(gridFolders.organizationId, organizationId), inArray(gridFolders.id, level)));
      }
      return { deleted: true, released: released.length };
    });
  },

  /* -------------------------------------------------------------- workbooks */

  async listWorkbooks(organizationId, folder) {
    const where = folder === "all" ? sql`true` : folder === null ? sql`w.folder_id is null` : sql`w.folder_id = ${folder}`;
    const rows = await db.execute<{
      id: string;
      folder_id: string | null;
      name: string;
      description: string | null;
      created_at: Date;
      updated_at: Date;
      table_count: number;
      row_count: number;
    }>(sql`
      select w.id, w.folder_id, w.name, w.description, w.created_at, w.updated_at,
        (select count(*)::int from grid_tables t where t.workbook_id = w.id and t.organization_id = w.organization_id) as table_count,
        (select count(*)::int from grid_rows r join grid_tables t on t.id = r.table_id and t.organization_id = r.organization_id
           where t.workbook_id = w.id and t.organization_id = w.organization_id) as row_count
      from grid_workbooks w
      where w.organization_id = ${organizationId} and ${where}
      order by w.updated_at desc, w.id`);
    return [...rows].map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tableCount: Number(r.table_count),
      rowCount: Number(r.row_count),
    }));
  },

  async getWorkbook(organizationId, id) {
    const [row] = await db.select().from(gridWorkbooks).where(and(eq(gridWorkbooks.organizationId, organizationId), eq(gridWorkbooks.id, id)));
    return row ? asWorkbook(row) : null;
  },

  async createWorkbook(organizationId, input) {
    return db.transaction(async (tx) => {
      if (input.folderId) {
        const [folder] = await tx.select({ id: gridFolders.id }).from(gridFolders).where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, input.folderId)));
        if (!folder) throw new NotFoundError("Folder not found");
      }
      const [workbook] = await tx.insert(gridWorkbooks).values({ organizationId, name: input.name, folderId: input.folderId }).returning();
      const [table] = await tx.insert(gridTables).values({ organizationId, workbookId: workbook.id, name: input.firstTableName, position: 1 }).returning();
      await seedTable(tx, organizationId, table.id);
      return { workbook: asWorkbook(workbook), table: asTable(table) };
    });
  },

  async updateWorkbook(organizationId, id, patch) {
    return db.transaction(async (tx) => {
      const values: Partial<typeof gridWorkbooks.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.folderId !== undefined) {
        if (patch.folderId !== null) {
          const [folder] = await tx.select({ id: gridFolders.id }).from(gridFolders).where(and(eq(gridFolders.organizationId, organizationId), eq(gridFolders.id, patch.folderId)));
          if (!folder) throw new NotFoundError("Destination folder not found");
        }
        values.folderId = patch.folderId;
      }
      const [row] = await tx.update(gridWorkbooks).set(values).where(and(eq(gridWorkbooks.organizationId, organizationId), eq(gridWorkbooks.id, id))).returning();
      return row ? asWorkbook(row) : null;
    });
  },

  async deleteWorkbook(organizationId, id) {
    const rows = await db.delete(gridWorkbooks).where(and(eq(gridWorkbooks.organizationId, organizationId), eq(gridWorkbooks.id, id))).returning({ id: gridWorkbooks.id });
    return rows.length > 0;
  },

  /* ----------------------------------------------------------------- tables */

  async listTables(organizationId, workbookId) {
    const rows = await db
      .select()
      .from(gridTables)
      .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId)))
      .orderBy(asc(gridTables.position), asc(gridTables.id));
    return rows.map(asTable);
  },

  async getTable(organizationId, id) {
    const [row] = await db.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)));
    return row ? asTable(row) : null;
  },

  async createTable(organizationId, input) {
    return db.transaction(async (tx) => {
      if (!(await lockWorkbook(tx, organizationId, input.workbookId))) throw new NotFoundError("Workbook not found");
      const count = await tableCount(tx, organizationId, input.workbookId);
      if (count >= input.maxTables) throw new ConflictError(`A workbook can hold at most ${input.maxTables} tables.`);
      const position = (await maxPosition(tx, organizationId, input.workbookId)) + 1;
      const [table] = await tx
        .insert(gridTables)
        .values({ organizationId, workbookId: input.workbookId, name: input.name ?? `Table ${Math.round(position)}`, description: input.description ?? null, position })
        .returning();
      await seedTable(tx, organizationId, table.id);
      return asTable(table);
    });
  },

  async updateTable(organizationId, id, patch) {
    const values: Partial<typeof gridTables.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.autoRun !== undefined) values.autoRun = patch.autoRun;
    // Replaced whole: the client sends the entire view, and a merge would make removing the last filter impossible.
    if (patch.view !== undefined) values.view = patch.view as Record<string, unknown>;
    const [row] = await db.update(gridTables).set(values).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id))).returning();
    return row ? asTable(row) : null;
  },

  async getUserView(organizationId, tableId, userId) {
    const [row] = await db
      .select({ view: gridUserViews.view })
      .from(gridUserViews)
      .where(and(eq(gridUserViews.organizationId, organizationId), eq(gridUserViews.tableId, tableId), eq(gridUserViews.userId, userId)));
    return row ? (row.view as TableView) : null;
  },

  async saveUserView(organizationId, tableId, userId, view) {
    // The composite foreign key rejects a table of another organization. The table is checked first so that
    // case answers 404 instead of a constraint error.
    const [table] = await db.select({ id: gridTables.id }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)));
    if (!table) throw new NotFoundError("Table not found");
    await db
      .insert(gridUserViews)
      .values({ organizationId, tableId, userId, view: view as Record<string, unknown> })
      .onConflictDoUpdate({ target: [gridUserViews.tableId, gridUserViews.userId], set: { view: view as Record<string, unknown>, updatedAt: new Date() } });
  },

  async deleteUserView(organizationId, tableId, userId) {
    await db.delete(gridUserViews).where(and(eq(gridUserViews.organizationId, organizationId), eq(gridUserViews.tableId, tableId), eq(gridUserViews.userId, userId)));
  },

  async moveTable(organizationId, id, destinationWorkbookId, maxTables) {
    return db.transaction(async (tx) => {
      // Lock order everywhere in this file: workbooks (in id order), then the table. deleteTable, reorderTables and
      // duplicateTable take the workbook first, so a move that took the table first could deadlock with them (40P01).
      const [peek] = await tx.select({ workbookId: gridTables.workbookId }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)));
      if (!peek) return null;
      if (peek.workbookId === destinationWorkbookId) {
        const [same] = await tx.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)));
        return same ? asTable(same) : null;
      }
      for (const workbookId of [peek.workbookId, destinationWorkbookId].sort()) {
        if (!(await lockWorkbook(tx, organizationId, workbookId))) throw new NotFoundError("Workbook not found");
      }
      const [table] = await tx.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id))).for("update");
      if (!table) return null;
      // Another move or a delete got in before the locks: what was read above is stale.
      if (table.workbookId !== peek.workbookId) throw new ConflictError("The table was moved by someone else. Try again.");
      if ((await tableCount(tx, organizationId, table.workbookId)) <= 1) throw new ConflictError("A workbook must keep at least one table. Duplicate it first.");
      if ((await tableCount(tx, organizationId, destinationWorkbookId)) >= maxTables) throw new ConflictError(`A workbook can hold at most ${maxTables} tables.`);
      // The moved table joins the end of the destination. Positions come from the same planner as a copy, so a
      // destination whose tabs were squeezed together is renumbered under the lock held above.
      const destination = await tx
        .select({ id: gridTables.id, position: gridTables.position })
        .from(gridTables)
        .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, destinationWorkbookId)))
        .orderBy(asc(gridTables.position), asc(gridTables.id));
      const { position, renumber } = placeAfter(destination);
      for (const move of renumber) {
        await tx.update(gridTables).set({ position: move.position, updatedAt: new Date() }).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, move.id)));
      }
      const [moved] = await tx
        .update(gridTables)
        .set({ workbookId: destinationWorkbookId, position, updatedAt: new Date() })
        .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)))
        .returning();
      return asTable(moved);
    });
  },

  async duplicateTable(organizationId, id, maxTables) {
    return db.transaction(async (tx) => {
      const [source] = await tx.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)));
      if (!source) return null;
      await lockWorkbook(tx, organizationId, source.workbookId);
      if ((await tableCount(tx, organizationId, source.workbookId)) >= maxTables) throw new ConflictError(`A workbook can hold at most ${maxTables} tables.`);

      // Sit between the source and the next tab, so the copy lands beside its original.
      // Positions are read under the workbook lock. When repeated copies of one tab have squeezed the gap, the tabs are renumbered.
      const tabs = await tx
        .select({ id: gridTables.id, position: gridTables.position })
        .from(gridTables)
        .where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, source.workbookId)))
        .orderBy(asc(gridTables.position), asc(gridTables.id));
      const { position, renumber } = placeAfter(tabs, source.id);
      for (const move of renumber) {
        await tx.update(gridTables).set({ position: move.position, updatedAt: new Date() }).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, move.id)));
      }

      const [copy] = await tx
        .insert(gridTables)
        .values({ organizationId, workbookId: source.workbookId, name: `${source.name} (copy)`.slice(0, 200), description: source.description, autoRun: source.autoRun, view: source.view, position })
        .returning();

      await tx.execute(sql`
        insert into grid_columns (organization_id, table_id, key, name, type, config, depends_on, position, auto_run)
        select organization_id, ${copy.id}, key, name, type, config, depends_on, position, auto_run
        from grid_columns where table_id = ${source.id} and organization_id = ${organizationId}`);

      // The version column takes a fresh value from the shared sequence per row: the polling cursor is global,
      // so copied versions would hide the new rows from a client whose cursor is already past them.
      // In-flight statuses describe jobs that are not copied, so they would spin forever in the copy.
      await tx.execute(sql`
        insert into grid_rows (organization_id, table_id, position, cells, cell_meta)
        select organization_id, ${copy.id}, position, cells,
          (select coalesce(jsonb_object_agg(m.key, m.value), '{}'::jsonb) from jsonb_each(cell_meta) as m
            where coalesce(m.value ->> 'status', '') not in ('queued', 'running', 'processing'))
        from grid_rows where table_id = ${source.id} and organization_id = ${organizationId}`);
      return asTable(copy);
    });
  },

  async reorderTables(organizationId, workbookId, orderedIds) {
    return db.transaction(async (tx) => {
      if (!(await lockWorkbook(tx, organizationId, workbookId))) throw new NotFoundError("Workbook not found");
      const existing = await tx.select({ id: gridTables.id }).from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId)));
      const known = new Set(existing.map((t) => t.id));
      // Length alone is not enough: [a, b, b] against three tables passes a size check and leaves a tab unpositioned.
      if (orderedIds.length !== known.size || orderedIds.some((id) => !known.has(id))) throw new ValidationError("That tab order no longer matches the workbook");
      for (const [index, tableId] of orderedIds.entries()) {
        await tx.update(gridTables).set({ position: index + 1, updatedAt: new Date() }).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, tableId)));
      }
      const rows = await tx.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.workbookId, workbookId))).orderBy(asc(gridTables.position));
      return rows.map(asTable);
    });
  },

  async deleteTable(organizationId, id) {
    return db.transaction(async (tx) => {
      const [table] = await tx.select().from(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id)));
      if (!table) return false;
      await lockWorkbook(tx, organizationId, table.workbookId);
      if ((await tableCount(tx, organizationId, table.workbookId)) <= 1) throw new ConflictError("A workbook must keep at least one table. Delete the workbook instead.");
      const deleted = await tx.delete(gridTables).where(and(eq(gridTables.organizationId, organizationId), eq(gridTables.id, id))).returning({ id: gridTables.id });
      return deleted.length > 0;
    });
  },

  async columnCoverage(organizationId, tableId, keys) {
    if (keys.length === 0) return {};
    // One pass with an aliased aggregate per column. Without explicit aliases Postgres names them all "count".
    const filled = sql.join(
      keys.map(
        (key, i) => sql`count(*) filter (where cells ->> ${key} is not null and cells ->> ${key} <> '')::int as ${sql.identifier(`c${i}`)}`,
      ),
      sql`, `,
    );
    const result = await db.execute<Record<string, number>>(sql`select count(*)::int as total, ${filled} from grid_rows where table_id = ${tableId} and organization_id = ${organizationId}`);
    const first = result[0] ?? {};
    const total = Number(first.total) || 0;
    if (!total) return Object.fromEntries(keys.map((k) => [k, 0]));
    return Object.fromEntries(keys.map((k, i) => [k, Math.round(((Number(first[`c${i}`]) || 0) / total) * 100)]));
  },
};
