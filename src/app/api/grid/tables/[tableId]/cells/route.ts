import { editCells, type CellUpdateInput } from "@/contexts/grid/application/row-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { idField, idParam, readJsonObject } from "../../../http";

function updateOf(raw: unknown): CellUpdateInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError("Every update needs a rowId and columnKey");
  const u = raw as Record<string, unknown>;
  if (typeof u.columnKey !== "string" || !u.columnKey) throw new ValidationError("Every update needs a columnKey");
  const expected = u.expectedVersion ?? u.version;
  if (expected !== undefined && expected !== null && typeof expected !== "number") throw new ValidationError("expectedVersion must be a number");
  return {
    rowId: idField(u.rowId, "rowId"),
    columnKey: u.columnKey,
    value: u.value,
    expectedVersion: expected ?? undefined,
    // Present even when null: null means "the cell is empty".
    expect: Object.prototype.hasOwnProperty.call(u, "expected") ? { value: u.expected } : undefined,
  };
}

/**
 * One cell: `{ rowId, columnKey, value, expectedVersion? }`. Many: `{ updates: [...] }`, each entry the same shape.
 * `expectedVersion` is the `version` of the row the client last read. If the row changed since, the request
 * answers 409 with `conflicts` (the current version and cells of each stale row) and writes nothing.
 * Without it the write wins. The response carries the updated rows with their new versions.
 * `expected` (any JSON value, null for an empty cell) makes one cell a compare-and-set under the row lock: a cell that
 * holds something else is left alone. The response lists `applied` (with the value written) and `skipped` (with the
 * value stored). `undo: true` marks a restore: no auto-run starts and the runner columns that read the cells turn stale.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/cells">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.cellsBodyBytes);
    if (body.updates !== undefined) {
      if (!Array.isArray(body.updates) || body.updates.length === 0 || body.updates.length > GRID_LIMITS.cellUpdates) {
        throw new ValidationError(`updates must hold between 1 and ${GRID_LIMITS.cellUpdates.toLocaleString("en-US")} cells`);
      }
      return editCells(gridDeps(), actor, id, body.updates.map(updateOf), { undo: body.undo === true });
    }
    return editCells(gridDeps(), actor, id, [updateOf(body)], { undo: body.undo === true });
  });
}
