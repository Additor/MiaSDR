import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import {
  archiveBlocker,
  cleanColumnName,
  deleteBlocker,
  findDuplicate,
  isCompleteOrder,
  newColumnKey,
  renameBlocker,
  type ColumnEntity,
} from "../domain/custom-columns";

/*
 * Permissions: any member reads the registry (the lead form and merge field pickers need the labels).
 * Creating, renaming, reordering, archiving, restoring and deleting need an owner or admin, because a
 * delete removes the values from every lead or company in the organization.
 */

export interface CustomColumn {
  id: string;
  entity: ColumnEntity;
  key: string;
  name: string;
  type: string;
  isCore: boolean;
  position: number;
  archivedAt: Date | null;
}

export interface CustomColumnWithUsage extends CustomColumn {
  /** Rows of the entity that hold a value under this key. */
  usedBy: number;
}

/** Operations inside one transaction that holds the organization's lock for the entity. */
export interface ColumnTx {
  all(): Promise<CustomColumn[]>;
  insert(input: { key: string; name: string; type: string; position: number }): Promise<CustomColumn>;
  setName(id: string, name: string): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  setPositions(order: string[]): Promise<void>;
  /** Removes the key from every row of the entity, then the column. Throwing undoes both. */
  deleteStripped(column: CustomColumn): Promise<{ strippedRows: number }>;
}

export interface CustomColumnStore {
  list(organizationId: string, entity: ColumnEntity, includeArchived: boolean): Promise<CustomColumnWithUsage[]>;
  /** Null when the id does not exist in the organization. */
  find(organizationId: string, id: string): Promise<CustomColumn | null>;
  transact<T>(organizationId: string, entity: ColumnEntity, fn: (tx: ColumnTx) => Promise<T>): Promise<T>;
}

function requireAdmin(actor: Actor): void {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can manage custom fields.");
}

export function listCustomColumns(store: CustomColumnStore, actor: Actor, input: { entity: ColumnEntity; includeArchived: boolean }) {
  return store.list(actor.organizationId, input.entity, input.includeArchived);
}

export async function createCustomColumn(store: CustomColumnStore, actor: Actor, input: { entity: ColumnEntity; name: string }): Promise<CustomColumn> {
  requireAdmin(actor);
  const checked = cleanColumnName(input.name);
  if (!checked.ok) throw new ValidationError(checked.problem);
  return store.transact(actor.organizationId, input.entity, async (tx) => {
    const all = await tx.all();
    const duplicate = findDuplicate(checked.name, all);
    if (duplicate) throw new ConflictError(duplicateMessage(duplicate.name, duplicate.archivedAt !== null));
    const key = newColumnKey(checked.name, all.map((c) => c.key));
    if (!key) throw new ValidationError("Use at least one letter or number in the name.");
    const position = all.reduce((max, c) => Math.max(max, c.position), 0) + 1;
    return tx.insert({ key, name: checked.name, type: "text", position });
  });
}

/** Changes the label only. The key and every stored value stay as they are. */
export async function renameCustomColumn(store: CustomColumnStore, actor: Actor, id: string, name: string): Promise<void> {
  requireAdmin(actor);
  const checked = cleanColumnName(name);
  if (!checked.ok) throw new ValidationError(checked.problem);
  const found = await locate(store, actor, id);
  await store.transact(actor.organizationId, found.entity, async (tx) => {
    const all = await tx.all();
    const current = all.find((c) => c.id === id);
    if (!current) throw new NotFoundError("Column not found");
    const blocked = renameBlocker(current);
    if (blocked) throw new ConflictError(blocked);
    const duplicate = findDuplicate(checked.name, all, id);
    if (duplicate) throw new ConflictError(duplicateMessage(duplicate.name, duplicate.archivedAt !== null));
    await tx.setName(id, checked.name);
  });
}

/** `ids` must list every active column of the entity once, in the new order. */
export async function reorderCustomColumns(store: CustomColumnStore, actor: Actor, input: { entity: ColumnEntity; ids: string[] }): Promise<void> {
  requireAdmin(actor);
  await store.transact(actor.organizationId, input.entity, async (tx) => {
    const active = (await tx.all()).filter((c) => c.archivedAt === null);
    if (!isCompleteOrder(input.ids, active)) throw new ConflictError("The field list changed. Reload and try again.");
    await tx.setPositions(input.ids);
  });
}

export async function archiveCustomColumn(store: CustomColumnStore, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  const found = await locate(store, actor, id);
  await store.transact(actor.organizationId, found.entity, async (tx) => {
    const current = (await tx.all()).find((c) => c.id === id);
    if (!current) throw new NotFoundError("Column not found");
    const blocked = archiveBlocker(current);
    if (blocked) throw new ConflictError(blocked);
    await tx.setArchived(id, true);
  });
}

export async function restoreCustomColumn(store: CustomColumnStore, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  const found = await locate(store, actor, id);
  await store.transact(actor.organizationId, found.entity, async (tx) => {
    const current = (await tx.all()).find((c) => c.id === id);
    if (!current) throw new NotFoundError("Column not found");
    if (current.archivedAt === null) throw new ConflictError("The field is not archived.");
    await tx.setArchived(id, false);
  });
}

/** Removes an archived column and its values from every row, in one transaction. */
export async function deleteCustomColumn(store: CustomColumnStore, actor: Actor, id: string): Promise<{ strippedRows: number }> {
  requireAdmin(actor);
  const found = await locate(store, actor, id);
  return store.transact(actor.organizationId, found.entity, async (tx) => {
    const current = (await tx.all()).find((c) => c.id === id);
    if (!current) throw new NotFoundError("Column not found");
    const blocked = deleteBlocker(current);
    if (blocked) throw new ConflictError(blocked);
    return tx.deleteStripped(current);
  });
}

async function locate(store: CustomColumnStore, actor: Actor, id: string): Promise<CustomColumn> {
  const found = await store.find(actor.organizationId, id);
  if (!found) throw new NotFoundError("Column not found");
  return found;
}

const duplicateMessage = (name: string, archived: boolean) =>
  archived ? `A field named "${name}" exists in the archive. Restore it or delete it first.` : `A field named "${name}" already exists.`;
