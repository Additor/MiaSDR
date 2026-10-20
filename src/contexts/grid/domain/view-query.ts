import { parseNumericText } from "./cell-values";

/**
 * Saved views and transient queries over a table: filters, sorts and search.
 * Pure shape handling. The SQL for a query lives in infrastructure.
 */

export const FILTER_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty", "contains", "notContains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterCondition = { columnKey: string; operator: FilterOperator; value?: string; disabled?: boolean };
export type FilterGroup = { conjunction: "and" | "or"; conditions: (FilterCondition | FilterGroup)[] };
export type SortSpec = { columnKey: string; direction: "asc" | "desc" };

export type GridQuery = { filters?: FilterGroup; sorts?: SortSpec[]; search?: string };

export type TableView = {
  hiddenColumns?: string[];
  pinnedColumns?: string[];
  filters?: FilterGroup;
  sorts?: SortSpec[];
};

/**
 * The keys a member can set for themselves. The table's own `view` is the shared default every member starts
 * from. A key a member stores wins over the default as a whole, pins included.
 */
export const PERSONAL_VIEW_KEYS = ["hiddenColumns", "pinnedColumns", "sorts", "filters"] as const;

/** Pinned columns stay sticky at the left edge, so more than three would leave no room to scroll. */
export const MAX_PINNED_COLUMNS = 3;

export const MAX_VIEW_DEPTH = 6;
export const MAX_VIEW_CONDITIONS = 200;
export const MAX_SORTS = 10;
export const MAX_SEARCH_CHARS = 200;
export const MAX_FILTER_VALUE_CHARS = 1_000;

const COMPARISONS: readonly FilterOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
export const isNumericFilterType = (type: string) => type === "number" || type === "currency";
/** True for operators that compare the cell with the filter value as a number on a number column. */
export const isNumericComparison = (operator: FilterOperator, type: string) => isNumericFilterType(type) && COMPARISONS.includes(operator);

/**
 * Reads the value of a number or currency filter. The grammar is the cell parser's (parseNumericText):
 * an optional sign, digits with an optional point (".5" and "5." work), an optional exponent ("1e5"),
 * thousands commas, currency symbols and codes, and parentheses for a negative. Anything else is null,
 * so "12abc", "50%" and "NaN" are not numbers. The SQL cast in view-sql.ts accepts the same plain
 * decimal and exponent forms, so a cell holding "+5" or "1e5" still filters and sorts.
 */
export const parseFilterNumber = (value: string): number | null => parseNumericText(value);

export const isFilterGroup = (c: FilterCondition | FilterGroup): c is FilterGroup => (c as FilterGroup).conditions !== undefined;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function pruneGroup(group: unknown, known: ReadonlySet<string>, depth: number, budget: { left: number }): FilterGroup {
  const raw = isObject(group) && Array.isArray(group.conditions) ? group : { conditions: [] };
  const conditions: (FilterCondition | FilterGroup)[] = [];
  for (const c of raw.conditions as unknown[]) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    if (!isObject(c)) continue;
    if (Array.isArray(c.conditions)) {
      if (depth < MAX_VIEW_DEPTH) conditions.push(pruneGroup(c, known, depth + 1, budget));
      continue;
    }
    if (typeof c.columnKey !== "string" || !known.has(c.columnKey)) continue;
    if (!FILTER_OPERATORS.includes(c.operator as FilterOperator)) continue;
    const value = typeof c.value === "string" ? c.value : typeof c.value === "number" || typeof c.value === "boolean" ? String(c.value) : undefined;
    conditions.push({
      columnKey: c.columnKey,
      operator: c.operator as FilterOperator,
      ...(value !== undefined ? { value: value.slice(0, MAX_FILTER_VALUE_CHARS) } : {}),
      ...(c.disabled === true ? { disabled: true } : {}),
    });
  }
  return { conjunction: raw.conjunction === "or" ? "or" : "and", conditions };
}

function pruneSorts(sorts: unknown, known: ReadonlySet<string>): SortSpec[] {
  if (!Array.isArray(sorts)) return [];
  return sorts
    .filter((s): s is SortSpec => isObject(s) && typeof s.columnKey === "string" && known.has(s.columnKey) && (s.direction === "asc" || s.direction === "desc"))
    .slice(0, MAX_SORTS)
    .map((s) => ({ columnKey: s.columnKey, direction: s.direction }));
}

/**
 * A copy of a saved view with everything the table can no longer apply removed.
 * A view outlives the columns it names, so reads degrade to "that filter is ignored".
 */
export function sanitizeView(view: unknown, known: ReadonlySet<string>): TableView {
  if (!isObject(view)) return {};
  const keys = (value: unknown) => (Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && known.has(k)) : undefined);
  const out: TableView = {};
  const hidden = keys(view.hiddenColumns);
  // A stored pin list can predate the limit or name a column twice; read it as the first valid pins.
  const pinned = keys(view.pinnedColumns)?.filter((k, i, all) => all.indexOf(k) === i).slice(0, MAX_PINNED_COLUMNS);
  if (hidden) out.hiddenColumns = hidden;
  if (pinned) out.pinnedColumns = pinned;
  if (isObject(view.filters)) out.filters = pruneGroup(view.filters, known, 0, { left: MAX_VIEW_CONDITIONS });
  if (Array.isArray(view.sorts)) out.sorts = pruneSorts(view.sorts, known);
  return out;
}

/**
 * `sanitizeView` for a member's stored override. A pin list that holds columns but ends up empty only because those
 * columns were deleted is dropped, so the member follows the default again. Left as `[]` it would read as "unpin
 * everything" and hide the admin's pins for good. A list the member saved empty on purpose is stored as `[]`
 * and stays empty.
 */
export function sanitizePersonalView(stored: unknown, known: ReadonlySet<string>): TableView {
  const out = sanitizeView(stored, known);
  if (isObject(stored) && Array.isArray(stored.pinnedColumns) && stored.pinnedColumns.length > 0 && out.pinnedColumns?.length === 0) delete out.pinnedColumns;
  return out;
}

/**
 * Strict check for a view being saved. Returns a message for the first problem, or null.
 * With `types` (column key to effective type) a comparison on a number column must carry a number.
 * A blank value stays legal: it means "no filter yet". A stored view that fails this later, because
 * a column changed type, is read as an inactive filter by the SQL builder.
 */
export function validateView(view: unknown, known: ReadonlySet<string>, types?: ReadonlyMap<string, string>, layer: "default" | "personal" = "default"): string | null {
  if (!isObject(view)) return "view must be an object";
  if (layer === "personal") {
    const extra = Object.keys(view).find((k) => !(PERSONAL_VIEW_KEYS as readonly string[]).includes(k));
    if (extra) return `"${extra}" is part of the default view. A personal view holds only hidden columns, pinned columns, sorts and filters.`;
  }
  for (const field of ["hiddenColumns", "pinnedColumns"] as const) {
    const list = view[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 500 || list.some((k) => typeof k !== "string")) return `${field} must be an array of column keys`;
  }
  if (view.pinnedColumns !== undefined) {
    const pins = view.pinnedColumns as string[];
    if (pins.length > MAX_PINNED_COLUMNS) return `Pin at most ${MAX_PINNED_COLUMNS} columns`;
    const unknown = pins.find((k) => !known.has(k));
    if (unknown !== undefined) return `Unknown column in pinned columns: "${unknown}"`;
    if (new Set(pins).size !== pins.length) return "A column can be pinned once";
  }
  if (view.sorts !== undefined) {
    if (!Array.isArray(view.sorts) || view.sorts.length > MAX_SORTS) return `sorts must be an array of up to ${MAX_SORTS} entries`;
    for (const s of view.sorts) {
      if (!isObject(s) || typeof s.columnKey !== "string") return "Each sort needs a columnKey";
      if (!known.has(s.columnKey)) return `Unknown column in sort: "${s.columnKey}"`;
      if (s.direction !== "asc" && s.direction !== "desc") return "Sort direction must be asc or desc";
    }
  }
  if (view.filters !== undefined) {
    let seen = 0;
    const visit = (group: unknown, depth: number): string | null => {
      if (!isObject(group) || !Array.isArray(group.conditions)) return "filters must be a group with a conditions array";
      if (group.conjunction !== "and" && group.conjunction !== "or") return "Filter conjunction must be and or or";
      if (depth > MAX_VIEW_DEPTH) return "Filters are nested too deeply";
      for (const c of group.conditions) {
        if (++seen > MAX_VIEW_CONDITIONS) return "Too many filter conditions";
        if (!isObject(c)) return "Each filter must be an object";
        if (Array.isArray(c.conditions)) {
          const nested = visit(c, depth + 1);
          if (nested) return nested;
          continue;
        }
        if (typeof c.columnKey !== "string") return "Each filter needs a columnKey";
        if (!known.has(c.columnKey)) return `Unknown column in filter: "${c.columnKey}"`;
        if (!FILTER_OPERATORS.includes(c.operator as FilterOperator)) return `Unknown filter operator: "${String(c.operator)}"`;
        const v = c.value;
        if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return "A filter value must be text";
        if (typeof v === "string" && v.length > MAX_FILTER_VALUE_CHARS) return "A filter value is too long";
        const type = types?.get(c.columnKey);
        if (type && isNumericComparison(c.operator as FilterOperator, type) && v !== undefined && v !== null && String(v).trim() !== "" && parseFilterNumber(String(v)) === null) {
          return `Filter value "${String(v).slice(0, 40)}" is not a number. Use digits like 5, -2.5, .5, 1e5 or 1,200.`;
        }
      }
      return null;
    };
    const problem = visit(view.filters, 0);
    if (problem) return problem;
  }
  return null;
}

/** Operators that compare with the filter value. "empty" and "notEmpty" read the cell alone. */
export const filterNeedsValue = (operator: FilterOperator) => operator !== "empty" && operator !== "notEmpty";

/**
 * Whether the SQL builder applies this condition. A muted condition, a comparison with a blank value and a
 * number comparison with text that is not a number narrow nothing. `type` is the column's effective type; leave
 * it undefined to skip the checks that need it. Keep this in step with conditionSql in view-sql.ts, whose tests
 * compare the two.
 */
export function isConditionActive(c: FilterCondition, type?: string): boolean {
  if (c.disabled) return false;
  if (!filterNeedsValue(c.operator)) return true;
  const value = c.value ?? "";
  if (value.trim() === "") return false;
  if (type !== undefined && isNumericComparison(c.operator, type) && parseFilterNumber(value) === null) return false;
  return true;
}

/**
 * How many conditions narrow the result. A group counts for the conditions inside it, so a group of muted
 * conditions counts zero. `types` maps a column key to its effective type; a key it lacks is inactive.
 */
export function activeConditionCount(group: FilterGroup | undefined, types?: ReadonlyMap<string, string>): number {
  if (!group) return 0;
  let n = 0;
  for (const c of group.conditions) {
    if (isFilterGroup(c)) n += activeConditionCount(c, types);
    else if (types && !types.has(c.columnKey)) continue;
    else if (isConditionActive(c, types?.get(c.columnKey))) n += 1;
  }
  return n;
}

const groupEmpty = (g: FilterGroup | undefined) => !g || g.conditions.length === 0;

/** Canonical form of one layer key, so "no filter" is the same whether it is missing, empty or an empty group. */
function normalizedKey(view: TableView, key: (typeof PERSONAL_VIEW_KEYS)[number]): unknown {
  if (key === "filters") return groupEmpty(view.filters) ? null : view.filters;
  return (view[key] ?? []).length === 0 ? [] : view[key];
}

/**
 * The view a member sees: the shared default with the member's own keys on top. A key the member stored wins
 * as a whole, even when it is empty ("no filter", "no sort", "nothing hidden"), because an empty override is
 * how a member turns a default off. A key the member never stored follows the default, including later changes
 * to it. Pins follow the same rule: a stored empty list unpins the default's columns for that member.
 */
export function mergeViews(shared: TableView, personal: TableView | null | undefined): TableView {
  const out: TableView = { ...shared };
  if (!personal) return out;
  if (personal.hiddenColumns !== undefined) out.hiddenColumns = personal.hiddenColumns;
  if (personal.pinnedColumns !== undefined) out.pinnedColumns = personal.pinnedColumns;
  if (personal.sorts !== undefined) out.sorts = personal.sorts;
  if (personal.filters !== undefined) out.filters = personal.filters;
  return out;
}

/**
 * The part of `desired` (what the member wants to see) that differs from the shared default. The client sends
 * the whole view it shows; only the keys that differ are stored, in explicit form (an empty array or an empty
 * group when the member turned the default off), so the keys that match keep following the default.
 */
export function personalOverride(shared: TableView, desired: TableView): TableView {
  const out: TableView = {};
  for (const key of PERSONAL_VIEW_KEYS) {
    if (JSON.stringify(normalizedKey(shared, key)) === JSON.stringify(normalizedKey(desired, key))) continue;
    if (key === "filters") out.filters = desired.filters ?? { conjunction: "and", conditions: [] };
    else out[key] = (desired[key] ?? []) as never;
  }
  return out;
}

/** Escapes LIKE metacharacters so "50%" matches literally. Use with ESCAPE '\'. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
