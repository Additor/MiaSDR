import { activeConditionCount, isFilterGroup, type FilterCondition, type FilterGroup, type FilterOperator, type SortSpec, type TableView } from "@/contexts/grid/domain/view-query";
import { countConditions } from "../edit/filter-edit";

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  empty: "is empty",
  notEmpty: "is not empty",
  contains: "contains",
  notContains: "does not contain",
};

export const operatorNeedsValue = (op: FilterOperator) => op !== "empty" && op !== "notEmpty";

const topGroup = (view: TableView): FilterGroup => view.filters ?? { conjunction: "and", conditions: [] };

export function addFilter(view: TableView, condition: FilterCondition): TableView {
  const group = topGroup(view);
  return { ...view, filters: { ...group, conditions: [...group.conditions, condition] } };
}

export function removeFilter(view: TableView, index: number): TableView {
  const group = topGroup(view);
  const conditions = group.conditions.filter((_, i) => i !== index);
  return { ...view, filters: conditions.length === 0 ? undefined : { ...group, conditions } };
}

export function setConjunction(view: TableView, conjunction: "and" | "or"): TableView {
  if (!view.filters) return view;
  return { ...view, filters: { ...view.filters, conjunction } };
}

/** Sets one sort on a column, replacing the column's old direction. `null` removes it. */
export function setSort(view: TableView, columnKey: string, direction: "asc" | "desc" | null, options: { only?: boolean } = {}): TableView {
  const others = options.only ? [] : (view.sorts ?? []).filter((s) => s.columnKey !== columnKey);
  const sorts: SortSpec[] = direction ? [...others, { columnKey, direction }] : others;
  return { ...view, sorts };
}

export function toggleHidden(view: TableView, columnKey: string, hidden: boolean): TableView {
  const set = new Set(view.hiddenColumns ?? []);
  if (hidden) set.add(columnKey);
  else set.delete(columnKey);
  return { ...view, hiddenColumns: [...set] };
}

export const sortOf = (view: TableView, columnKey: string): "asc" | "desc" | null => view.sorts?.find((s) => s.columnKey === columnKey)?.direction ?? null;

export const hasQuery = (view: TableView) => (view.filters?.conditions.length ?? 0) > 0 || (view.sorts?.length ?? 0) > 0;

/** True when a filter condition narrows the rows. Muted conditions, blank values and conditions on lost columns do not. */
export const filtersNarrow = (view: TableView, types?: ReadonlyMap<string, string>) => activeConditionCount(view.filters, types) > 0;

/**
 * True when the loaded rows are the table in table order, so a new row can be appended in place. Only active
 * conditions count: the server ignores a muted one, so a view that holds only muted conditions shows every row.
 * Pass `types` (column key to effective type) to also ignore number comparisons whose value is not a number.
 */
export const keepsTableOrder = (view: TableView, search: string, types?: ReadonlyMap<string, string>) => !search.trim() && !filtersNarrow(view, types) && (view.sorts?.length ?? 0) === 0;

export const describeCondition = (c: FilterCondition | FilterGroup, nameOf: (key: string) => string): string => {
  if (isFilterGroup(c)) return `Group of ${countConditions(c)}`;
  return `${nameOf(c.columnKey)} ${OPERATOR_LABELS[c.operator]}${operatorNeedsValue(c.operator) ? ` "${c.value ?? ""}"` : ""}${c.disabled ? " (muted)" : ""}`;
};
