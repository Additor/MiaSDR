import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { companies, entityColumns, people } from "@/platform/db/schema";
import type { ColumnTx, CustomColumn, CustomColumnStore, CustomColumnWithUsage } from "../application/custom-columns";
import type { ColumnEntity } from "../domain/custom-columns";

const selection = {
  id: entityColumns.id,
  entity: entityColumns.entity,
  key: entityColumns.key,
  name: entityColumns.name,
  type: entityColumns.type,
  isCore: entityColumns.isCore,
  position: entityColumns.position,
  archivedAt: entityColumns.archivedAt,
};

const table = (entity: ColumnEntity) => (entity === "people" ? people : companies);

function ordered<T extends { position: number; name: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function txFor(tx: DbTx, organizationId: string, entity: ColumnEntity): ColumnTx {
  const scope = and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, entity));
  return {
    async all() {
      return (await tx.select(selection).from(entityColumns).where(scope).orderBy(asc(entityColumns.position))) as CustomColumn[];
    },
    async insert(input) {
      const [row] = await tx.insert(entityColumns).values({ organizationId, entity, ...input }).returning(selection);
      return row as CustomColumn;
    },
    async setName(id, name) {
      await tx.update(entityColumns).set({ name }).where(and(scope, eq(entityColumns.id, id)));
    },
    async setArchived(id, archived) {
      await tx.update(entityColumns).set({ archivedAt: archived ? new Date() : null }).where(and(scope, eq(entityColumns.id, id)));
    },
    async setPositions(order) {
      for (const [index, id] of order.entries()) {
        await tx.update(entityColumns).set({ position: index + 1 }).where(and(scope, eq(entityColumns.id, id)));
      }
    },
    async deleteStripped(column) {
      const rows = table(entity);
      const stripped = await tx
        .update(rows)
        .set({ custom: sql`${rows.custom} - ${column.key}::text` })
        .where(and(eq(rows.organizationId, organizationId), sql`${rows.custom} ? ${column.key}::text`))
        .returning({ id: rows.id });
      await tx.delete(entityColumns).where(and(scope, eq(entityColumns.id, column.id)));
      return { strippedRows: stripped.length };
    },
  };
}

export const drizzleCustomColumnStore: CustomColumnStore = {
  async list(organizationId, entity, includeArchived) {
    const rows = (await db
      .select(selection)
      .from(entityColumns)
      .where(
        and(
          eq(entityColumns.organizationId, organizationId),
          eq(entityColumns.entity, entity),
          includeArchived ? undefined : isNull(entityColumns.archivedAt),
        ),
      )) as CustomColumn[];
    const source = table(entity);
    const usage = await db.execute<{ key: string; n: number }>(
      sql`select k.key, count(*)::int as n from ${source} r, jsonb_object_keys(r.custom) as k(key) where r.organization_id = ${organizationId} group by k.key`,
    );
    const used = new Map(usage.map((u) => [u.key, u.n]));
    return ordered(rows.map((r): CustomColumnWithUsage => ({ ...r, usedBy: used.get(r.key) ?? 0 })));
  },

  async find(organizationId, id) {
    const [row] = await db
      .select(selection)
      .from(entityColumns)
      .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.id, id)));
    return (row as CustomColumn | undefined) ?? null;
  },

  transact(organizationId, entity, fn) {
    return db.transaction(async (tx) => {
      // One writer per organization and entity, so two admins cannot both claim a name or interleave a reorder.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-columns:" + organizationId + ":" + entity}, 0))`);
      return fn(txFor(tx, organizationId, entity));
    });
  },
};
