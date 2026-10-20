import { isBlankValue } from "./cell-values";
import type { FilterCondition, FilterGroup, TableView } from "./view-query";

export const TEXT_SPLIT_DELIMITERS = ["comma", "space", "semicolon", "pipe"] as const;
export type TextSplitDelimiter = (typeof TEXT_SPLIT_DELIMITERS)[number];

export const MAX_SPLIT_COLUMNS = 100;
export const MAX_SPLIT_CELLS = 50_000;

export function splitValue(value: unknown, delimiter: TextSplitDelimiter): string[] {
  if (value === undefined || value === null || String(value).trim() === "") return [];
  const raw = String(value);
  const parts = delimiter === "space" ? raw.trim().split(/\s+/) : raw.split(delimiter === "comma" ? "," : delimiter === "semicolon" ? ";" : "|");
  return parts.map((part) => part.trim());
}

/** Ids of rows whose value in `key` repeats an earlier row's. Blank values never count as duplicates. The first row stays. */
export function duplicateRowIds(rows: ReadonlyArray<{ id: string; cells: Record<string, unknown> }>, key: string): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const value = row.cells[key];
    if (isBlankValue(value)) continue;
    const identity = `${typeof value}:${JSON.stringify(value)}`;
    if (seen.has(identity)) duplicates.push(row.id);
    else seen.add(identity);
  }
  return duplicates;
}

/** The view without any mention of a deleted column. */
export function removeColumnFromView(view: TableView, columnKey: string): TableView {
  const clean = (conditions: (FilterCondition | FilterGroup)[]): (FilterCondition | FilterGroup)[] =>
    conditions
      .map((c) => ("conditions" in c ? { ...c, conditions: clean(c.conditions) } : c.columnKey === columnKey ? null : c))
      .filter((c): c is FilterCondition | FilterGroup => c !== null);
  return {
    ...view,
    hiddenColumns: view.hiddenColumns?.filter((k) => k !== columnKey),
    pinnedColumns: view.pinnedColumns?.filter((k) => k !== columnKey),
    sorts: view.sorts?.filter((s) => s.columnKey !== columnKey),
    filters: view.filters ? { ...view.filters, conditions: clean(view.filters.conditions) } : undefined,
  };
}
