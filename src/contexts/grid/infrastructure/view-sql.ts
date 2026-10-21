import { sql, type SQL } from "drizzle-orm";
import { gridRows } from "@/platform/db/schema";
import { escapeLike, isFilterGroup, isNumericComparison, isNumericFilterType, parseFilterNumber, type FilterCondition, type FilterGroup, type GridQuery, type SortSpec } from "../domain/view-query";
import type { ColumnRef } from "../application/ports";

/*
 * Filtering and sorting over the jsonb value plane. Column keys and user values are bound
 * parameters, never interpolated. A key reaches SQL only after the domain pruned the query to
 * columns the table has.
 */

/**
 * Cell text that casts to numeric: an optional sign, digits with an optional point ("5.", ".5") and an
 * optional exponent ("1e5"). This is the plain-decimal part of parseNumericText in the domain. Cells of
 * a number column hold jsonb numbers, so thousands commas and currency symbols never reach the cast.
 * The exponent is capped at three digits so a cell like "1e999999" cannot overflow numeric and abort the query.
 */
const NUMERIC_TEXT = "^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]{1,3})?$";

/** Numbers need a cast, and the cast is guarded: one non-numeric string would otherwise abort the whole query. */
function valueExpr(key: string, type: string): SQL {
  const raw = sql`${gridRows.cells} ->> ${key}`;
  return isNumericFilterType(type) ? sql`(case when ${raw} ~ ${NUMERIC_TEXT} then (${raw})::numeric end)` : raw;
}

const likePattern = (value: string) => `%${escapeLike(value)}%`;

function conditionSql(c: FilterCondition, types: Map<string, string>): SQL | null {
  const type = types.get(c.columnKey);
  if (!type) return null;
  const left = valueExpr(c.columnKey, type);
  const raw = sql`${gridRows.cells} ->> ${c.columnKey}`;
  if (c.operator === "empty") return sql`(${raw} is null or ${raw} = '')`;
  if (c.operator === "notEmpty") return sql`(${raw} is not null and ${raw} <> '')`;
  if (c.operator === "runFailed") return sql`(${gridRows.cellMeta} -> ${c.columnKey} ->> 'status') = 'error'`;
  // A blank value means "no filter yet". Treating it as an empty-text comparison would hide every row while the person types.
  const value = c.value ?? "";
  if (value.trim() === "") return null;
  // A number filter value the domain cannot parse is an inactive filter. Saving such a view fails in
  // validateView, so this only covers a stored view whose column changed type. Binding NULL would make
  // every comparison match nothing and "is not" match everything.
  let bound: SQL | null = null;
  if (isNumericComparison(c.operator, type)) {
    const n = parseFilterNumber(value);
    if (n === null) return null;
    bound = sql`${String(n)}::numeric`;
  } else {
    bound = sql`${value}`;
  }
  switch (c.operator) {
    case "eq":
      return sql`${left} = ${bound}`;
    case "neq":
      return sql`(${left} is distinct from ${bound})`;
    case "gt":
      return sql`${left} > ${bound}`;
    case "gte":
      return sql`${left} >= ${bound}`;
    case "lt":
      return sql`${left} < ${bound}`;
    case "lte":
      return sql`${left} <= ${bound}`;
    case "contains":
      return sql`${raw} ilike ${likePattern(value)} escape '\\'`;
    case "notContains":
      return sql`(${raw} is null or ${raw} not ilike ${likePattern(value)} escape '\\')`;
    default:
      return null;
  }
}

function groupSql(group: FilterGroup, types: Map<string, string>): SQL | null {
  const parts = group.conditions
    .filter((c) => isFilterGroup(c) || !c.disabled)
    .map((c) => (isFilterGroup(c) ? groupSql(c, types) : conditionSql(c, types)))
    .filter((p): p is SQL => p !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return sql`(${sql.join(parts, group.conjunction === "or" ? sql` or ` : sql` and `)})`;
}

/** The WHERE fragment for a query, or null when nothing narrows the result. */
export function buildWhere(query: GridQuery | undefined, columns: readonly ColumnRef[]): SQL | null {
  if (!query) return null;
  const types = new Map(columns.map((c) => [c.key, c.type]));
  const parts: SQL[] = [];
  if (query.filters) {
    const filters = groupSql(query.filters, types);
    if (filters) parts.push(filters);
  }
  const term = query.search?.trim();
  if (term && columns.length > 0) {
    const pattern = likePattern(term);
    parts.push(sql`(${sql.join(columns.map((c) => sql`${gridRows.cells} ->> ${c.key} ilike ${pattern} escape '\\'`), sql` or `)})`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` and `)})`;
}

/** ORDER BY ending in position so equal values keep a stable order. Unset cells sort last in both directions. */
export function buildOrderBy(sorts: readonly SortSpec[] | undefined, columns: readonly ColumnRef[]): SQL {
  const types = new Map(columns.map((c) => [c.key, c.type]));
  const parts: SQL[] = [];
  for (const s of sorts ?? []) {
    const type = types.get(s.columnKey);
    if (!type) continue;
    const expr = valueExpr(s.columnKey, type);
    parts.push(s.direction === "desc" ? sql`${expr} desc nulls last` : sql`${expr} asc nulls last`);
  }
  parts.push(sql`${gridRows.position} asc`, sql`${gridRows.id} asc`);
  return sql.join(parts, sql`, `);
}
