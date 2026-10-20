import { pasteCells } from "@/contexts/grid/application/paste-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/shared/api";
import { idParam, readJsonObject } from "../../../http";

/**
 * A pasted block anchored at a row: `{ anchorRowId, columnKeys, newColumns?, values, search? }`. The rows after the
 * anchor in table order take the lines (rows the client has not loaded included); missing rows and `newColumns`
 * text columns are created, in one transaction. Answers 422 for more than 1,000 rows, 5,000 cells or 100 new columns,
 * and for a filtered, sorted or searched view, which cannot grow. The answer lists `applied` cells with their value
 * before, so the client can record one undo step.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/paste">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.cellsBodyBytes);
    return pasteCells(gridDeps(), actor, id, body);
  });
}
