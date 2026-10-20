import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { effectiveColumnType } from "../domain/column-types";
import { cleanName } from "../domain/keys";
import { mergeViews, personalOverride, sanitizePersonalView, sanitizeView, validateView, type TableView } from "../domain/view-query";
import { tableTokens } from "../domain/formula-dependencies";
import { refreshLookupDependentsQuietly } from "./formula-lookup-refresh";
import { GRID_LIMITS } from "./limits";
import type { ColumnStore, GridDeps, TableRecord } from "./ports";

/*
 * Permissions: every member of the organization can use the grid, the same as the
 * leads database. Ids of another organization answer NotFound.
 */

const FOLDER_FALLBACK = "Untitled folder";
const WORKBOOK_FALLBACK = "Untitled workbook";

type Structure = Pick<GridDeps, "structure">;
type StructureAndColumns = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

const optionalText = (value: unknown, label: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be text`);
  if (value.length > 2_000) throw new ValidationError(`${label} must be 2,000 characters or fewer`);
  return value.trim() || null;
};

/* ---------------------------------------------------------------- folders */

/** `parentId` undefined lists every folder (move pickers). `null` lists the root. */
export async function listFolders(deps: Structure, actor: Actor, parentId?: string | null) {
  if (parentId === undefined) return { folders: await deps.structure.listAllFolders(actor.organizationId) };
  return { folders: await deps.structure.listFolders(actor.organizationId, parentId) };
}

export async function getFolder(deps: Structure, actor: Actor, id: string) {
  const folder = await deps.structure.getFolder(actor.organizationId, id);
  if (!folder) throw new NotFoundError("Folder not found");
  const [folders, workbooks, path] = await Promise.all([
    deps.structure.listFolders(actor.organizationId, id),
    deps.structure.listWorkbooks(actor.organizationId, id),
    deps.structure.folderPath(actor.organizationId, id),
  ]);
  return { folder, folders, workbooks, path };
}

export async function createFolder(deps: Structure, actor: Actor, input: { name?: unknown; parentId?: string | null }) {
  const name = cleanName(input.name, "name", FOLDER_FALLBACK);
  const folder = await deps.structure.createFolder(actor.organizationId, { name, parentId: input.parentId ?? null });
  return { folder };
}

export async function updateFolder(deps: Structure, actor: Actor, id: string, patch: { name?: unknown; parentId?: string | null }) {
  const folder = await deps.structure.updateFolder(actor.organizationId, id, {
    name: patch.name === undefined ? undefined : cleanName(patch.name, "name"),
    parentId: patch.parentId,
  });
  if (!folder) throw new NotFoundError("Folder not found");
  return { folder };
}

export async function deleteFolder(deps: Structure, actor: Actor, id: string) {
  const { deleted, released } = await deps.structure.deleteFolder(actor.organizationId, id);
  if (!deleted) throw new NotFoundError("Folder not found");
  return { ok: true, released };
}

/* -------------------------------------------------------------- workbooks */

/** `folder` of "all" lists every workbook, null the root. */
export async function listWorkbooks(deps: Structure, actor: Actor, folder: string | null | "all") {
  return { workbooks: await deps.structure.listWorkbooks(actor.organizationId, folder) };
}

export async function getWorkbook(deps: Structure, actor: Actor, id: string) {
  const workbook = await deps.structure.getWorkbook(actor.organizationId, id);
  if (!workbook) throw new NotFoundError("Workbook not found");
  return { workbook, tables: await deps.structure.listTables(actor.organizationId, id) };
}

export async function createWorkbook(deps: Structure, actor: Actor, input: { name?: unknown; firstTableName?: unknown; folderId?: string | null }) {
  return deps.structure.createWorkbook(actor.organizationId, {
    name: cleanName(input.name, "name", WORKBOOK_FALLBACK),
    firstTableName: cleanName(input.firstTableName, "firstTableName", "Custom Table"),
    folderId: input.folderId ?? null,
  });
}

export async function updateWorkbook(deps: Structure, actor: Actor, id: string, patch: { name?: unknown; description?: unknown; folderId?: string | null }) {
  const workbook = await deps.structure.updateWorkbook(actor.organizationId, id, {
    name: patch.name === undefined ? undefined : cleanName(patch.name, "name"),
    description: optionalText(patch.description, "description"),
    folderId: patch.folderId,
  });
  if (!workbook) throw new NotFoundError("Workbook not found");
  return { workbook };
}

export async function deleteWorkbook(deps: Structure, actor: Actor, id: string) {
  if (!(await deps.structure.deleteWorkbook(actor.organizationId, id))) throw new NotFoundError("Workbook not found");
  return { ok: true };
}

/* ----------------------------------------------------------------- tables */

export async function listTables(deps: Structure, actor: Actor, workbookId: string) {
  if (!(await deps.structure.getWorkbook(actor.organizationId, workbookId))) throw new NotFoundError("Workbook not found");
  return { tables: await deps.structure.listTables(actor.organizationId, workbookId) };
}

export async function createTable(deps: Structure, actor: Actor, input: { workbookId: string; name?: unknown; description?: unknown }) {
  if (!(await deps.structure.getWorkbook(actor.organizationId, input.workbookId))) throw new NotFoundError("Workbook not found");
  const name = input.name === undefined || (typeof input.name === "string" && input.name.trim() === "") ? undefined : cleanName(input.name, "name");
  const table = await deps.structure.createTable(actor.organizationId, {
    workbookId: input.workbookId,
    name,
    description: optionalText(input.description, "description"),
    maxTables: GRID_LIMITS.tablesPerWorkbook,
  });
  return { table };
}

export interface TablePatch {
  name?: unknown;
  description?: unknown;
  autoRun?: unknown;
  view?: unknown;
  /** Move the table to this workbook first. */
  workbookId?: string;
}

export async function updateTable(deps: StructureAndColumns, actor: Actor, tableId: string, patch: TablePatch) {
  const org = actor.organizationId;
  // The table's view is the default every member starts from, so changing it takes an owner or admin.
  if (patch.view !== undefined && !isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change the default view. Your own sort, filter and hidden columns are saved for you.");
  if (patch.autoRun !== undefined && typeof patch.autoRun !== "boolean") throw new ValidationError("autoRun must be true or false");
  const fields: { name?: string; description?: string | null; autoRun?: boolean; view?: TableView } = {};
  if (patch.name !== undefined) fields.name = cleanName(patch.name, "name");
  const description = optionalText(patch.description, "description");
  if (description !== undefined) fields.description = description;
  if (patch.autoRun !== undefined) fields.autoRun = patch.autoRun as boolean;

  let table: TableRecord | null = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");

  if (patch.view !== undefined) {
    const columns = await deps.columns.list(org, tableId);
    const problem = validateView(patch.view, new Set(columns.map((c) => c.key)), new Map(columns.map((c) => [c.key, effectiveColumnType(c)])));
    if (problem) throw new ValidationError(problem);
    // Stored as given after validation. Reads sanitize again, so a later column delete cannot break the table.
    fields.view = patch.view as TableView;
  }

  const original = table;
  if (patch.workbookId !== undefined && patch.workbookId !== table.workbookId) {
    if (!(await deps.structure.getWorkbook(org, patch.workbookId))) throw new NotFoundError("Destination workbook not found");
    table = await deps.structure.moveTable(org, tableId, patch.workbookId, GRID_LIMITS.tablesPerWorkbook);
    if (!table) throw new NotFoundError("Table not found");
  }
  if (Object.keys(fields).length > 0) {
    table = await deps.structure.updateTable(org, tableId, fields);
    if (!table) throw new NotFoundError("Table not found");
  }
  // LOOKUPs name the table, so a move or a rename changes what they resolve to. The old workbook loses the
  // table and the new one may start to resolve a name it could not before.
  if (table.workbookId !== original.workbookId) {
    await refreshLookupDependentsQuietly(deps, org, original.workbookId, { tableTokens: tableTokens(original), columnTokens: null }, `"${original.name}"`);
    await refreshLookupDependentsQuietly(deps, org, table.workbookId, { tableTokens: tableTokens(table), columnTokens: null }, `"${table.name}"`);
  } else if (table.name !== original.name) {
    await refreshLookupDependentsQuietly(deps, org, table.workbookId, { tableTokens: [...tableTokens(original), table.name], columnTokens: null }, `"${original.name}"`);
  }
  // The new default is what this person was looking at, so their own override no longer has a reason to exist.
  if (fields.view !== undefined) await deps.structure.deleteUserView(org, tableId, actor.userId);
  return { table };
}

export async function duplicateTable(deps: Structure, actor: Actor, tableId: string) {
  const table = await deps.structure.duplicateTable(actor.organizationId, tableId, GRID_LIMITS.tablesPerWorkbook);
  if (!table) throw new NotFoundError("Table not found");
  return { table };
}

export async function reorderTables(deps: Structure, actor: Actor, workbookId: string, tableIds: string[]) {
  if (new Set(tableIds).size !== tableIds.length) throw new ValidationError("tableIds must not repeat a table");
  if (!(await deps.structure.getWorkbook(actor.organizationId, workbookId))) throw new NotFoundError("Workbook not found");
  return { tables: await deps.structure.reorderTables(actor.organizationId, workbookId, tableIds) };
}

export async function deleteTable(deps: StructureAndColumns, actor: Actor, tableId: string) {
  const table = await deps.structure.getTable(actor.organizationId, tableId);
  if (!table || !(await deps.structure.deleteTable(actor.organizationId, tableId))) throw new NotFoundError("Table not found");
  // Formulas that looked the table up show #REF from now on.
  await refreshLookupDependentsQuietly(deps, actor.organizationId, table.workbookId, { tableTokens: tableTokens(table), columnTokens: null }, `"${table.name}"`);
  return { ok: true };
}

/** The saved view with everything the table can no longer apply removed. */
export function viewOf(table: { view: Record<string, unknown> }, columns: ReadonlyArray<{ key: string }>): TableView {
  return sanitizeView(table.view, new Set(columns.map((c) => c.key)));
}

export interface ResolvedView {
  /** What this member sees: the default with their own keys on top. */
  view: TableView;
  /** The shared default, sanitized. */
  defaultView: TableView;
  /** True when the member has stored a key of their own. */
  personal: boolean;
  /** Owners and admins can save the default. */
  canEditDefault: boolean;
}

const holdsOverride = (v: TableView) => v.hiddenColumns !== undefined || v.pinnedColumns !== undefined || v.sorts !== undefined || v.filters !== undefined;

/** The view a member reads a table through. Both layers are sanitized against the current columns. */
export async function resolveView(deps: Structure, actor: Actor, table: { id: string; view: Record<string, unknown> }, columns: ReadonlyArray<{ key: string }>): Promise<ResolvedView> {
  const known = new Set(columns.map((c) => c.key));
  const stored = await deps.structure.getUserView(actor.organizationId, table.id, actor.userId);
  const defaultView = sanitizeView(table.view, known);
  const mine = stored ? sanitizePersonalView(stored, known) : null;
  const personal = mine !== null && holdsOverride(mine);
  return { view: mergeViews(defaultView, mine), defaultView, personal, canEditDefault: isOwnerOrAdmin(actor.role) };
}

/**
 * Saves the member's own view. `desired` is the whole view the member now sees; the keys that differ from the
 * default are stored, so a member who matches the default again holds no row at all.
 */
export async function saveMyView(deps: StructureAndColumns, actor: Actor, tableId: string, desired: unknown) {
  const org = actor.organizationId;
  const table = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const columns = await deps.columns.list(org, tableId);
  const known = new Set(columns.map((c) => c.key));
  const types = new Map(columns.map((c) => [c.key, effectiveColumnType(c)] as const));
  const problem = validateView(desired, known, types);
  if (problem) throw new ValidationError(problem);
  const override = personalOverride(sanitizeView(table.view, known), desired as TableView);
  const stored = validateView(override, known, types, "personal");
  if (stored) throw new ValidationError(stored);
  if (Object.keys(override).length === 0) await deps.structure.deleteUserView(org, tableId, actor.userId);
  else await deps.structure.saveUserView(org, tableId, actor.userId, override);
  return resolveView(deps, actor, table, columns);
}

/** Drops the member's own view so the default applies again. */
export async function resetMyView(deps: Structure & { columns: ColumnStore }, actor: Actor, tableId: string) {
  const org = actor.organizationId;
  const table = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");
  await deps.structure.deleteUserView(org, tableId, actor.userId);
  return resolveView(deps, actor, table, await deps.columns.list(org, tableId));
}
