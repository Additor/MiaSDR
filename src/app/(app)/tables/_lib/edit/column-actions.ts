import { MAX_PINNED_COLUMNS } from "@/contexts/grid/domain/view-query";
import { isStaticColumnType } from "@/contexts/grid/domain/column-types";
import { RUNNER_TYPES_WITH_RUN } from "../view/format";

/** Everything a column header menu, a cell or a keyboard shortcut can ask the workspace to do to a column. */
export type ColumnAction =
  | { kind: "rename" }
  | { kind: "type"; type: string }
  | { kind: "config" }
  | { kind: "sort"; direction: "asc" | "desc" | null }
  | { kind: "filter" }
  | { kind: "hide" }
  | { kind: "dedupe" }
  | { kind: "textToColumns" }
  | { kind: "insert"; side: "left" | "right" }
  | { kind: "move"; side: "left" | "right" }
  | { kind: "delete" }
  | { kind: "run" }
  | { kind: "retry" }
  | { kind: "recalculate" }
  | { kind: "pin" }
  | { kind: "unpin" }
  | { kind: "duplicate" } // static and formula columns, values copied
  | { kind: "runFirstN"; count: number }; // the first `count` rows in table order

export type ColumnActionKind = ColumnAction["kind"];

export interface ColumnActionContext {
  column: { type: string };
  /** Whether this column is in the member's pinned list. */
  pinned: boolean;
  /** How many columns are pinned now. */
  pinCount: number;
}

/** Whether the menu offers `kind` for this column. Kinds without a column rule are always offered. */
export function isColumnActionOffered(kind: ColumnActionKind, ctx: ColumnActionContext): boolean {
  switch (kind) {
    case "pin":
      return !ctx.pinned && ctx.pinCount < MAX_PINNED_COLUMNS;
    case "unpin":
      return ctx.pinned;
    case "duplicate":
      return isStaticColumnType(ctx.column.type) || ctx.column.type === "formula";
    case "runFirstN":
      return RUNNER_TYPES_WITH_RUN.has(ctx.column.type);
    default:
      return true;
  }
}

/** Why the menu shows Pin column greyed out, or null when pinning is open (or the column is pinned already). */
export function pinBlockedReason(ctx: Pick<ColumnActionContext, "pinned" | "pinCount">): string | null {
  if (ctx.pinned || ctx.pinCount < MAX_PINNED_COLUMNS) return null;
  return `Up to ${MAX_PINNED_COLUMNS} columns can be pinned`;
}

/**
 * The request that duplicates a column: a "(copy)" next to the original, same type and config. A data column also
 * copies its values (`copyValuesFrom`, one SQL update on the server). A formula column copies its expression and
 * the server recalculates it. Returns null for a runner column, which the menu does not offer either.
 */
export function duplicateColumnRequest(column: { id: string; key: string; name: string; type: string; config?: Record<string, unknown> }): Record<string, unknown> | null {
  const isFormula = column.type === "formula";
  if (!isFormula && !isStaticColumnType(column.type)) return null;
  return {
    name: `${column.name} (copy)`.slice(0, 200),
    type: column.type,
    config: column.config ?? {},
    afterColumnId: column.id,
    ...(isFormula ? {} : { copyValuesFrom: column.key }),
  };
}
