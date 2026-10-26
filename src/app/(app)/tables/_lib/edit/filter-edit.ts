import { RUNNABLE_TYPES } from "@/contexts/grid/domain/column-types";
import { isFilterGroup, MAX_SORTS, MAX_VIEW_CONDITIONS, MAX_VIEW_DEPTH, isNumericFilterType, type FilterCondition, type FilterGroup, type FilterOperator, type SortSpec } from "@/contexts/grid/domain/view-query";

/*
 * Pure edits for the filter and sort panel. The panel holds a draft filter group and a draft sort list,
 * changes them with these functions and saves the result once. A path is the list of child indexes from the
 * root group: [] is the root, [2] its third child, [2, 0] the first child of the group at [2].
 */

export type NodePath = readonly number[];

export const emptyGroup = (): FilterGroup => ({ conjunction: "and", conditions: [] });

const TEXT_OPERATORS: FilterOperator[] = ["contains", "notContains", "eq", "neq", "empty", "notEmpty"];
const ORDERED_OPERATORS: FilterOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"];
const EXACT_OPERATORS: FilterOperator[] = ["eq", "neq", "empty", "notEmpty"];

/** The operators the panel offers for a column type, best default first. A runner column also offers "run failed". */
export function operatorsFor(type: string, options: { runs?: boolean } = {}): FilterOperator[] {
  const base = isNumericFilterType(type) || type === "date" ? ORDERED_OPERATORS : type === "boolean" || type === "select" ? EXACT_OPERATORS : TEXT_OPERATORS;
  return options.runs ? [...base, "runFailed"] : base;
}

/** Runner columns, the ones whose own cell records a failed run. Their output columns carry no run state. */
export const RUN_FILLED_TYPES = RUNNABLE_TYPES;

export const defaultOperatorFor = (type: string): FilterOperator => operatorsFor(type)[0];

/** The operator to keep when the column changes: the current one if the new type offers it, else the new default. */
export const operatorAfterColumnChange = (current: FilterOperator, type: string): FilterOperator => (operatorsFor(type).includes(current) ? current : defaultOperatorFor(type));

export function groupAt(root: FilterGroup, path: NodePath): FilterGroup | null {
  let node: FilterGroup = root;
  for (const index of path) {
    const child = node.conditions[index];
    if (!child || !isFilterGroup(child)) return null;
    node = child;
  }
  return node;
}

export function nodeAt(root: FilterGroup, path: NodePath): FilterCondition | FilterGroup | null {
  if (path.length === 0) return root;
  const parent = groupAt(root, path.slice(0, -1));
  return parent?.conditions[path[path.length - 1]] ?? null;
}

/** Rebuilds `root` with the group at `path` replaced by `change(group)`. An unknown path returns `root` itself. */
function editGroup(root: FilterGroup, path: NodePath, change: (group: FilterGroup) => FilterGroup): FilterGroup {
  if (path.length === 0) return change(root);
  const [head, ...rest] = path;
  const child = root.conditions[head];
  if (!child || !isFilterGroup(child)) return root;
  const next = editGroup(child, rest, change);
  if (next === child) return root;
  return { ...root, conditions: root.conditions.map((c, i) => (i === head ? next : c)) };
}

export function countConditions(group: FilterGroup): number {
  return group.conditions.reduce((n, c) => n + (isFilterGroup(c) ? countConditions(c) : 1), 0);
}

/** Depth of the deepest group below `group`. A group with no subgroups is 0. */
export function groupDepth(group: FilterGroup): number {
  return group.conditions.reduce((d, c) => (isFilterGroup(c) ? Math.max(d, 1 + groupDepth(c)) : d), 0);
}

export function canAddCondition(root: FilterGroup): boolean {
  return countConditions(root) < MAX_VIEW_CONDITIONS;
}

/** A new group at `path` sits at depth path.length + 1; validateView allows depth up to MAX_VIEW_DEPTH. */
export function canAddGroup(root: FilterGroup, path: NodePath): boolean {
  return path.length + 1 <= MAX_VIEW_DEPTH && countConditions(root) < MAX_VIEW_CONDITIONS;
}

export function addCondition(root: FilterGroup, path: NodePath, condition: FilterCondition): FilterGroup {
  if (!canAddCondition(root)) return root;
  return editGroup(root, path, (g) => ({ ...g, conditions: [...g.conditions, condition] }));
}

/** Adds a subgroup holding one condition, so the panel never shows an empty group. */
export function addGroup(root: FilterGroup, path: NodePath, first: FilterCondition): FilterGroup {
  if (!canAddGroup(root, path)) return root;
  return editGroup(root, path, (g) => ({ ...g, conditions: [...g.conditions, { conjunction: g.conjunction === "and" ? "or" : "and", conditions: [first] }] }));
}

export function setGroupConjunction(root: FilterGroup, path: NodePath, conjunction: "and" | "or"): FilterGroup {
  return editGroup(root, path, (g) => (g.conjunction === conjunction ? g : { ...g, conjunction }));
}

/** Changes fields of the condition at `path`. A group at `path` is left alone. */
export function updateCondition(root: FilterGroup, path: NodePath, patch: Partial<FilterCondition>): FilterGroup {
  if (path.length === 0) return root;
  const index = path[path.length - 1];
  return editGroup(root, path.slice(0, -1), (g) => {
    const target = g.conditions[index];
    if (!target || isFilterGroup(target)) return g;
    const next: FilterCondition = { ...target, ...patch };
    if (next.disabled !== true) delete next.disabled;
    return { ...g, conditions: g.conditions.map((c, i) => (i === index ? next : c)) };
  });
}

export function toggleMuted(root: FilterGroup, path: NodePath): FilterGroup {
  const node = nodeAt(root, path);
  if (!node || isFilterGroup(node)) return root;
  return updateCondition(root, path, { disabled: node.disabled === true ? undefined : true });
}

/** Removes the node at `path`. A subgroup left with no children goes too. The root stays, possibly empty. */
export function removeNode(root: FilterGroup, path: NodePath): FilterGroup {
  if (path.length === 0) return root;
  const index = path[path.length - 1];
  const parentPath = path.slice(0, -1);
  const removed = editGroup(root, parentPath, (g) => (index < g.conditions.length ? { ...g, conditions: g.conditions.filter((_, i) => i !== index) } : g));
  return parentPath.length > 0 && groupAt(removed, parentPath)?.conditions.length === 0 ? removeNode(removed, parentPath) : removed;
}

/** The group to save: empty subgroups pruned, and `undefined` when no condition is left. */
export function normalizeFilters(root: FilterGroup | undefined): FilterGroup | undefined {
  if (!root) return undefined;
  const conditions: FilterGroup["conditions"] = [];
  for (const c of root.conditions) {
    if (!isFilterGroup(c)) {
      conditions.push(c);
      continue;
    }
    const inner = normalizeFilters(c);
    if (inner) conditions.push(inner);
  }
  return conditions.length === 0 ? undefined : { ...root, conditions };
}

// ----- sorts -----

export function canAddSort(sorts: readonly SortSpec[]): boolean {
  return sorts.length < MAX_SORTS;
}

/** The first column no sort uses yet, or null when every column already sorts. */
export function nextSortColumn(sorts: readonly SortSpec[], columnKeys: readonly string[]): string | null {
  const used = new Set(sorts.map((s) => s.columnKey));
  return columnKeys.find((k) => !used.has(k)) ?? null;
}

export function addSort(sorts: readonly SortSpec[], columnKey: string, direction: "asc" | "desc" = "asc"): SortSpec[] {
  if (!canAddSort(sorts) || sorts.some((s) => s.columnKey === columnKey)) return [...sorts];
  return [...sorts, { columnKey, direction }];
}

/** Points sort `index` at another column. A column that already has a sort is refused, so each column sorts once. */
export function setSortColumn(sorts: readonly SortSpec[], index: number, columnKey: string): SortSpec[] {
  if (!sorts[index] || sorts.some((s, i) => i !== index && s.columnKey === columnKey)) return [...sorts];
  return sorts.map((s, i) => (i === index ? { ...s, columnKey } : s));
}

export function setSortDirection(sorts: readonly SortSpec[], index: number, direction: "asc" | "desc"): SortSpec[] {
  return sorts.map((s, i) => (i === index ? { ...s, direction } : s));
}

export function removeSortAt(sorts: readonly SortSpec[], index: number): SortSpec[] {
  return sorts.filter((_, i) => i !== index);
}

/** Moves a sort one place up (-1) or down (1). The first sort has the most weight. */
export function moveSort(sorts: readonly SortSpec[], index: number, delta: -1 | 1): SortSpec[] {
  const to = index + delta;
  if (!sorts[index] || to < 0 || to >= sorts.length) return [...sorts];
  const next = [...sorts];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
