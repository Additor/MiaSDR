import { registerCellsChangedListener } from "../application/cell-events";
import { cascadeFromEdits } from "../application/enrichment-run";
import type { GridDeps } from "../application/ports";
import { isStaticColumnType } from "../domain/column-types";
import { campaignHandoff } from "./campaign-handoff";
import { drizzleColumnStore } from "./drizzle-column-store";
import { drizzleCellRunStore, drizzleFormulaStore } from "./drizzle-formula-store";
import { drizzleRowStore } from "./drizzle-row-store";
import { drizzleStructureStore } from "./drizzle-structure-store";
import { gridRunDeps } from "./enrichment-composition";
import { createFormulaAuthor } from "./formula-author";

/** The grid's adapters. Routes call `gridDeps()` per request. */
export const gridDeps = (): GridDeps => ({
  structure: drizzleStructureStore,
  columns: drizzleColumnStore,
  rows: drizzleRowStore,
  formulas: drizzleFormulaStore,
  cellRuns: drizzleCellRunStore,
  handoff: campaignHandoff,
  formulaAuthor: createFormulaAuthor(),
});

/**
 * A saved edit queues the auto-run columns that read the edited cells. The check against the column
 * list comes first, so a paste into a table without runner columns costs one query, not one per row.
 */
registerCellsChangedListener(async (event) => {
  const columns = await drizzleColumnStore.list(event.organizationId, event.tableId);
  const changedKeys = new Set(event.changes.map((c) => c.columnKey));
  const runners = columns.filter((c) => !isStaticColumnType(c.type) && c.dependsOn.some((key) => changedKeys.has(key)));
  if (runners.length === 0) return 0;

  const byRow = new Map<string, string[]>();
  for (const change of event.changes) byRow.set(change.rowId, [...(byRow.get(change.rowId) ?? []), change.columnKey]);
  return cascadeFromEdits(gridRunDeps(), event.organizationId, event.tableId, byRow);
});
