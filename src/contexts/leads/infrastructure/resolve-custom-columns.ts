import { and, eq, inArray, sql } from "drizzle-orm";
import { ConflictError } from "@/shared/errors";
import type { DbTx } from "@/platform/db/client";
import { entityColumns } from "@/platform/db/schema";
import { findDuplicate, newColumnKey } from "../domain/custom-columns";

export interface ColumnRequest {
  /** The key the caller derived from the label. */
  key: string;
  name: string;
}

const returning = {
  id: entityColumns.id,
  key: entityColumns.key,
  name: entityColumns.name,
  isCore: entityColumns.isCore,
  archivedAt: entityColumns.archivedAt,
  position: entityColumns.position,
};

/**
 * Finds or creates the people column for each label with the registry's rules: a label that matches an
 * existing column by folded name (archived ones included) reuses that column's key and restores it,
 * and a new label gets a key that cannot collide. Takes the registry's lock, so a concurrent create
 * or rename in the registry cannot claim the same name. Returns requested key -> stored key and name.
 * `restoreArchived: false` refuses a label that matches an archived column instead of restoring it, for
 * callers whose actor cannot restore columns. The default restores.
 */
export async function resolvePeopleColumns(
  tx: DbTx,
  organizationId: string,
  requests: ColumnRequest[],
  options: { restoreArchived?: boolean } = {},
): Promise<Map<string, { key: string; name: string }>> {
  const resolved = new Map<string, { key: string; name: string }>();
  if (requests.length === 0) return resolved;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-columns:" + organizationId + ":people"}, 0))`);
  const all = await tx
    .select(returning)
    .from(entityColumns)
    .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people")));
  const restore: string[] = [];
  let position = all.reduce((max, c) => Math.max(max, c.position), 0);
  for (const request of requests) {
    const match = findDuplicate(request.name, all);
    if (match) {
      if (match.archivedAt) {
        if (options.restoreArchived === false) {
          throw new ConflictError(`A field named ${match.name} is archived. Ask an owner or admin to restore it first.`);
        }
        restore.push(match.id);
        match.archivedAt = null;
      }
      resolved.set(request.key, { key: match.key, name: match.name });
      continue;
    }
    const key = newColumnKey(request.name, all.map((c) => c.key));
    if (!key) continue;
    position += 1;
    const [row] = await tx
      .insert(entityColumns)
      .values({ organizationId, entity: "people", key, name: request.name, type: "text", position })
      .returning(returning);
    all.push(row);
    resolved.set(request.key, { key: row.key, name: row.name });
  }
  if (restore.length > 0) await tx.update(entityColumns).set({ archivedAt: null }).where(inArray(entityColumns.id, restore));
  return resolved;
}
