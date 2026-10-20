/**
 * Column types of the grid. Static columns hold values a person typed or imported.
 * Runner columns get their value from something that executes (a formula, an
 * enrichment, an AI call). The list matches the CHECK constraint on grid_columns.
 */

export const STATIC_COLUMN_TYPES = [
  "text", "number", "currency", "boolean", "date", "url", "email", "image", "select", "multiselect", "json",
] as const;

export const RUNNER_COLUMN_TYPES = [
  "enrichment", "integration_output", "ai_output", "http", "ai", "functions", "message", "waterfall", "formula", "merge",
] as const;

export type StaticColumnType = (typeof STATIC_COLUMN_TYPES)[number];
export type RunnerColumnType = (typeof RUNNER_COLUMN_TYPES)[number];
export type ColumnType = StaticColumnType | RunnerColumnType;

export const ALL_COLUMN_TYPES: readonly ColumnType[] = [...STATIC_COLUMN_TYPES, ...RUNNER_COLUMN_TYPES];

export const isStaticColumnType = (type: string): type is StaticColumnType => (STATIC_COLUMN_TYPES as readonly string[]).includes(type);
export const isColumnType = (type: string): type is ColumnType => (ALL_COLUMN_TYPES as readonly string[]).includes(type);

/** Column types whose cells hold plain strings. A formula sees a blank one as "". */
export const TEXT_LIKE_TYPES: ReadonlySet<string> = new Set(["text", "url", "email", "select", "image"]);

/** The type a cell is displayed and filtered as: output columns carry their own value type in config. */
export function effectiveColumnType(column: { type: string; config?: Record<string, unknown> }): string {
  if (column.type === "ai_output" || column.type === "integration_output") {
    const valueType = column.config?.valueType;
    return typeof valueType === "string" && isStaticColumnType(valueType) ? valueType : "text";
  }
  return column.type;
}
