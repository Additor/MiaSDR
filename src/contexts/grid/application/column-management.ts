import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { convertStoredValue } from "../domain/cell-values";
import { assertNoCycle, prepareColumnConfig } from "../domain/column-config";
import { isColumnType, isStaticColumnType, type ColumnType } from "../domain/column-types";
import { cleanName, placeAfter, placeBefore, uniqueColumnKey, uniqueColumnName } from "../domain/keys";
import { removeColumnFromView, TEXT_SPLIT_DELIMITERS, duplicateRowIds, splitValue, MAX_SPLIT_CELLS, MAX_SPLIT_COLUMNS, type TextSplitDelimiter } from "../domain/column-operations";
import { effectiveColumnType } from "../domain/column-types";
import { columnTokens, tableTokens } from "../domain/formula-dependencies";
import { refreshAfterSourceWrite, refreshLookupDependentsQuietly } from "./formula-lookup-refresh";
import { recalculateFormula, recalculateFormulasQuietly } from "./formula-recalc";
import { GRID_LIMITS } from "./limits";
import type { ColumnRecord, ColumnUpdate, GridDeps } from "./ports";

/**
 * Extension point for column types that run (enrichment, ai, http, waterfall and so on). The module
 * that owns a type registers a hook to validate its config and name the columns it reads.
 * Without a hook, a runner column keeps any JSON object config and its dependencies are read
 * from {{key}} tokens and columnKey properties.
 */
export interface ColumnTypeHook {
  /** Throws ValidationError for a bad config. `siblings` are the table's other columns. */
  validate?(config: Record<string, unknown>, siblings: ReadonlyArray<ColumnRecord>): void;
  /** Overrides the default dependency scan. */
  dependsOn?(config: Record<string, unknown>): string[];
}

const hooks = new Map<string, ColumnTypeHook>();

export function registerColumnTypeHook(type: ColumnType, hook: ColumnTypeHook): void {
  hooks.set(type, hook);
}

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "formulas">;

async function requireTable(deps: Deps, actor: Actor, tableId: string) {
  const table = await deps.structure.getTable(actor.organizationId, tableId);
  if (!table) throw new NotFoundError("Table not found");
  return table;
}

export async function listColumns(deps: Deps, actor: Actor, tableId: string) {
  await requireTable(deps, actor, tableId);
  return { columns: await deps.columns.list(actor.organizationId, tableId) };
}

function prepare(type: ColumnType, rawConfig: unknown, siblings: ReadonlyArray<ColumnRecord>, ownKey: string | null) {
  // A runner column the grid core cannot validate is created by the module that runs it, never from raw JSON.
  if (!isStaticColumnType(type) && type !== "formula" && !hooks.has(type)) {
    throw new ValidationError(`${type} columns are created from their own setup dialog`);
  }
  const prepared = prepareColumnConfig(type, rawConfig, new Set(siblings.map((c) => c.key)), ownKey);
  const hook = hooks.get(type);
  if (hook?.validate) hook.validate(prepared.config, siblings);
  if (hook?.dependsOn) {
    const own = ownKey;
    prepared.dependsOn = hook.dependsOn(prepared.config).filter((key) => key !== own);
  }
  return prepared;
}

export interface CreateColumnInput {
  name: unknown;
  type: unknown;
  config?: unknown;
  autoRun?: boolean;
  afterColumnId?: string;
  beforeColumnId?: string;
  copyValuesFrom?: string;
}

export async function createColumn(deps: Deps, actor: Actor, tableId: string, input: CreateColumnInput) {
  await requireTable(deps, actor, tableId);
  const name = cleanName(input.name, "name");
  if (typeof input.type !== "string" || !isColumnType(input.type)) throw new ValidationError("Unknown column type");
  const type = input.type;

  const column = await deps.columns.create(actor.organizationId, tableId, (existing) => {
    if (existing.length >= GRID_LIMITS.columnsPerTable) throw new ValidationError(`A table can have at most ${GRID_LIMITS.columnsPerTable} columns`);
    const key = uniqueColumnKey(name, new Set(existing.map((c) => c.key)));

    if (input.copyValuesFrom !== undefined) {
      const source = existing.find((c) => c.key === input.copyValuesFrom);
      if (!source) throw new ValidationError("The column to copy values from no longer exists");
      if (!isStaticColumnType(source.type)) throw new ValidationError("Values can only be copied from a data column");
      if (!isStaticColumnType(type)) throw new ValidationError("Copied values need a data column type");
    }
    const { config, dependsOn } = prepare(type, input.config, existing, key);
    assertNoCycle(existing, { key, dependsOn });

    const ordered = [...existing].sort((a, b) => a.position - b.position);
    const { position, renumber } = input.beforeColumnId ? placeBefore(ordered, input.beforeColumnId) : placeAfter(ordered, input.afterColumnId);
    return { key, name: uniqueColumnName(name, existing.map((c) => c.name)), type, config, dependsOn, position, renumber, autoRun: input.autoRun ?? true, copyValuesFrom: input.copyValuesFrom };
  });
  if (!column) throw new NotFoundError("Table not found");
  if (column.type === "formula") await recalculateFormulasQuietly(deps, actor.organizationId, tableId, { columnKeys: [column.key] });
  return { column };
}

export interface UpdateColumnInput {
  name?: unknown;
  type?: unknown;
  config?: unknown;
  autoRun?: boolean;
  /** Reposition after this column. Null moves it to the front. */
  afterColumnId?: string | null;
}

export async function updateColumn(deps: Deps, actor: Actor, tableId: string, columnId: string, input: UpdateColumnInput) {
  const table = await requireTable(deps, actor, tableId);
  let before: ColumnRecord | undefined;
  const column = await deps.columns.update(actor.organizationId, tableId, columnId, (current, siblings) => {
    before = current;
    const update: ColumnUpdate = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name, "name");
      const renamed = name.toLowerCase() !== current.name.trim().toLowerCase();
      // Only a real rename is checked: a table made before names were unique can hold two "Formula" columns.
      if (renamed && siblings.some((c) => c.id !== current.id && c.name.trim().toLowerCase() === name.toLowerCase())) {
        throw new ValidationError(`A column named "${name}" already exists`);
      }
      update.name = name;
    }
    if (input.autoRun !== undefined) update.autoRun = input.autoRun;

    if (input.afterColumnId !== undefined) {
      const others = siblings.filter((c) => c.id !== current.id).sort((a, b) => a.position - b.position);
      if (input.afterColumnId !== null && !others.some((c) => c.id === input.afterColumnId)) throw new ValidationError("afterColumnId must be another column in this table");
      const placement = placeAfter(others, input.afterColumnId, true);
      update.position = placement.position;
      update.renumber = placement.renumber;
    }

    if (input.type !== undefined || input.config !== undefined) {
      if (input.type !== undefined && (typeof input.type !== "string" || !isColumnType(input.type))) throw new ValidationError("Unknown column type");
      const type = (input.type as ColumnType | undefined) ?? current.type;
      const others = siblings.filter((c) => c.id !== current.id);
      const { config, dependsOn } = prepare(type, input.config ?? current.config, others, current.key);
      assertNoCycle(siblings, { key: current.key, dependsOn });
      update.type = type;
      update.config = config;
      update.dependsOn = dependsOn;
      if (type !== current.type && isStaticColumnType(type)) {
        if (isStaticColumnType(current.type)) update.convertValues = (value) => convertStoredValue(value, type);
        else update.dropJobs = true;
      }
    }
    return update;
  });
  if (!column) throw new NotFoundError("Column not found");
  const reconfigured = input.type !== undefined || input.config !== undefined;
  if (column.type === "formula" && reconfigured) await recalculateFormulasQuietly(deps, actor.organizationId, tableId, { columnKeys: [column.key] });
  // Formulas that look this column up now resolve differently (a new name, another type) or read new values.
  const old = before as ColumnRecord | undefined;
  if (old && (old.name !== column.name || old.type !== column.type || (column.type === "formula" && reconfigured))) {
    await refreshLookupDependentsQuietly(deps, actor.organizationId, table.workbookId, { tableTokens: tableTokens(table), columnTokens: [...columnTokens(old), ...columnTokens(column)] }, `"${table.name}"`);
  }
  return { column };
}

/** Columns an AI or enrichment column writes into, by its mapping or their back-reference. */
function outputsOf(column: ColumnRecord, siblings: ReadonlyArray<ColumnRecord>): ColumnRecord[] {
  const keys = new Set<string>();
  const outputColumns = column.config.outputColumns;
  if (column.type === "ai" && outputColumns && typeof outputColumns === "object") for (const key of Object.values(outputColumns)) if (typeof key === "string") keys.add(key);
  const outputs = column.config.outputs;
  if (column.type === "enrichment" && outputs && typeof outputs === "object") for (const key of Object.values(outputs)) if (typeof key === "string") keys.add(key);
  for (const candidate of siblings) {
    if ((candidate.type === "ai_output" || candidate.type === "integration_output") && candidate.config.sourceColumnKey === column.key) keys.add(candidate.key);
  }
  keys.delete(column.key);
  return siblings.filter((c) => keys.has(c.key));
}

export async function deleteColumn(deps: Deps, actor: Actor, tableId: string, columnId: string, options: { withOutputs?: boolean } = {}) {
  const table = await requireTable(deps, actor, tableId);
  let removed: ColumnRecord[] = [];
  const result = await deps.columns.remove(actor.organizationId, tableId, columnId, (column, siblings, view) => {
    const doomed = [column, ...(options.withOutputs ? outputsOf(column, siblings) : [])];
    removed = doomed;
    const doomedKeys = new Set(doomed.map((c) => c.key));
    const dependents = siblings.filter((c) => !doomedKeys.has(c.key) && c.dependsOn.some((key) => doomedKeys.has(key)));
    if (dependents.length > 0) throw new ValidationError(`Column is used by: ${dependents.map((c) => c.name).join(", ")}`);

    // Sources that still list a doomed column as one of their outputs lose that entry.
    const configUpdates: Array<{ id: string; config: Record<string, unknown>; dependsOn?: string[] }> = [];
    for (const parent of siblings) {
      if (doomedKeys.has(parent.key)) continue;
      if (parent.type === "ai") {
        const map = (parent.config.outputColumns ?? {}) as Record<string, string>;
        const removed = Object.entries(map).filter(([, key]) => doomedKeys.has(key)).map(([field]) => field);
        if (removed.length === 0) continue;
        const outputs = Array.isArray(parent.config.outputs) ? (parent.config.outputs as Array<{ key?: string }>) : [];
        configUpdates.push({
          id: parent.id,
          config: {
            ...parent.config,
            outputColumns: Object.fromEntries(Object.entries(map).filter(([field]) => !removed.includes(field))),
            outputs: outputs.filter((field) => !removed.includes(field.key ?? "")),
          },
        });
      } else if (parent.type === "enrichment") {
        const map = (parent.config.outputs ?? {}) as Record<string, string>;
        const kept = Object.entries(map).filter(([, key]) => !doomedKeys.has(key));
        if (kept.length === Object.keys(map).length) continue;
        configUpdates.push({ id: parent.id, config: { ...parent.config, outputs: Object.fromEntries(kept) } });
      }
    }
    let nextView = view;
    for (const key of doomedKeys) nextView = removeColumnFromView(nextView, key);
    return { deleteIds: doomed.map((c) => c.id), configUpdates, view: nextView };
  });
  if (!result) throw new NotFoundError("Column not found");
  // Formulas that looked the column up show #REF from now on.
  await refreshLookupDependentsQuietly(deps, actor.organizationId, table.workbookId, { tableTokens: tableTokens(table), columnTokens: removed.flatMap(columnTokens) }, `"${table.name}"`);
  return { ok: true, deletedColumnIds: result.deletedIds };
}

/**
 * Recomputes a formula column for every row now, including LOOKUPs against tables that changed since the last run.
 * It clears the "stale" marker and rewrites error cells. Unlike the quiet recalculation after an edit, a failure
 * answers the request, so the person who pressed the button learns about it. Formulas that look this column up
 * are refreshed in turn.
 */
export async function recalculateColumn(deps: Deps, actor: Actor, tableId: string, columnId: string) {
  const table = await requireTable(deps, actor, tableId);
  const columns = await deps.columns.list(actor.organizationId, tableId);
  const column = columns.find((c) => c.id === columnId);
  if (!column) throw new NotFoundError("Column not found");
  if (column.type !== "formula") throw new ValidationError("Only formula columns can be recalculated");
  const changed = await recalculateFormula(deps, actor.organizationId, tableId, column.key);
  const lookups = await refreshLookupDependentsQuietly(deps, actor.organizationId, table.workbookId, { tableTokens: tableTokens(table), columnTokens: columnTokens(column) }, `"${table.name}"`);
  return { recalculated: true, changedCells: changed, dependentColumns: lookups.recalculated, staleColumns: lookups.stale };
}

/* ------------------------------------------------------ column operations */

/** Removes rows whose value in the column repeats an earlier row's. The first row stays. Blank values never match. */
export async function dedupeColumn(deps: Deps, actor: Actor, tableId: string, columnId: string) {
  const table = await deps.structure.getTable(actor.organizationId, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const deleted = await deps.rows.deleteDuplicates(actor.organizationId, tableId, columnId, (rows, column) => duplicateRowIds(rows, column.key));
  if (deleted === null) throw new NotFoundError("Column not found");
  if (deleted > 0) await refreshAfterSourceWrite(deps, actor.organizationId, table);
  return { deleted };
}

/** Splits a text column into new text columns to its right. The original stays, so nothing is lost. */
export async function textToColumns(deps: Deps, actor: Actor, tableId: string, columnId: string, delimiter: unknown) {
  await requireTable(deps, actor, tableId);
  if (typeof delimiter !== "string" || !(TEXT_SPLIT_DELIMITERS as readonly string[]).includes(delimiter)) throw new ValidationError("Choose a valid separator");
  const result = await deps.columns.splitText(actor.organizationId, tableId, columnId, (source, siblings, rows) => {
    if (effectiveColumnType(source) !== "text") throw new ValidationError("Text to columns is only available for text columns");
    const splitRows = rows.map((row) => ({ row, parts: splitValue(row.cells[source.key], delimiter as TextSplitDelimiter) }));
    const outputCount = Math.max(0, ...splitRows.map(({ parts }) => parts.length));
    if (outputCount < 2) throw new ValidationError("No values in this column contain that separator");
    if (outputCount > MAX_SPLIT_COLUMNS) throw new ValidationError(`Text to columns can create at most ${MAX_SPLIT_COLUMNS} columns at a time`);
    if (rows.length * outputCount > MAX_SPLIT_CELLS) throw new ValidationError(`Text to columns is limited to ${MAX_SPLIT_CELLS.toLocaleString("en-US")} output cells at a time`);
    if (siblings.length + outputCount > GRID_LIMITS.columnsPerTable) throw new ValidationError(`A table can have at most ${GRID_LIMITS.columnsPerTable} columns`);

    const ordered = [...siblings].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((c) => c.id === source.id);
    const next = ordered[index + 1]?.position;
    const step = next === undefined ? 1 : (next - source.position) / (outputCount + 1);
    const taken = new Set(siblings.map((c) => c.key));
    const names = siblings.map((c) => c.name);
    const columns = Array.from({ length: outputCount }, (_, i) => {
      const name = uniqueColumnName(`${source.name} ${i + 1}`, names);
      names.push(name);
      const key = uniqueColumnKey(name, taken);
      taken.add(key);
      return { key, name, type: "text" as const, config: {}, dependsOn: [], position: source.position + step * (i + 1), autoRun: false };
    });
    const patches = splitRows.map(({ row, parts }) => ({ rowId: row.id, patch: Object.fromEntries(columns.map((c, i) => [c.key, parts[i] || null])) }));
    return { columns, patches };
  });
  if (!result) throw new NotFoundError("Column not found");
  return { columnsCreated: result.columns.length, rowsUpdated: result.rowsUpdated };
}
