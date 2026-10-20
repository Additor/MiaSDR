import { NotFoundError, type Actor } from "@/shared/errors";
import type { ColumnRecord, GridDeps } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "rows" | "cellRuns">;

const RUN_TYPES = new Set(["enrichment", "ai", "http", "formula"]);

/** The column whose run produced a cell: the column itself, or the source an output column points back to. */
function sourceOf(column: ColumnRecord, columns: readonly ColumnRecord[]): ColumnRecord | null {
  let sourceKey: string | null = null;
  if (RUN_TYPES.has(column.type)) sourceKey = column.key;
  else if ((column.type === "integration_output" || column.type === "ai_output") && typeof column.config.sourceColumnKey === "string") sourceKey = column.config.sourceColumnKey;
  else {
    // An AI output created before ai_output existed is an ordinary column that the AI column lists in outputColumns.
    sourceKey =
      columns.find((c) => c.type === "ai" && Object.values((c.config.outputColumns ?? {}) as Record<string, unknown>).includes(column.key))?.key ?? null;
  }
  const source = sourceKey ? columns.find((c) => c.key === sourceKey) : undefined;
  return source && RUN_TYPES.has(source.type) ? source : null;
}

/** The latest recorded run behind a cell: provider, outcome, cost, latency and the request and response. Read only. */
export async function getCellDetails(deps: Deps, actor: Actor, tableId: string, rowId: string, columnKey: string) {
  const org = actor.organizationId;
  const [table, columns, [row]] = await Promise.all([deps.structure.getTable(org, tableId), deps.columns.list(org, tableId), deps.rows.listByIds(org, tableId, [rowId])]);
  const column = columns.find((c) => c.key === columnKey);
  if (!table || !row || !column) throw new NotFoundError("Cell not found");
  const source = sourceOf(column, columns);
  if (!source) throw new NotFoundError("Cell not found");

  const head = { sourceColumnKey: source.key, sourceColumnName: source.name, sourceColumnType: source.type, canAddResponseColumn: source.type === "enrichment" };
  const run = await deps.cellRuns.latestRun(org, tableId, rowId, source.key);
  if (!run) return { ...head, run: null };
  return {
    ...head,
    // A formula runs locally and stores no response, so its answer is the cell itself.
    run: { ...run, response: run.response ?? (source.type === "formula" ? { result: row.cells[source.key] ?? null } : null) },
  };
}
