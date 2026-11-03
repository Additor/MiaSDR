import { addRows, deleteRows } from "@/contexts/grid/application/row-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idList, idParam, readJsonObject } from "../../../http";

/** Body `{ count }` appends blank rows. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/rows">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return addRows(gridDeps(), actor, id, body.count);
  }, 201);
}

/** Body `{ rowIds }`. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/rows">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return deleteRows(gridDeps(), actor, id, idList(body.rowIds, "rowIds", GRID_LIMITS.deleteRows));
  });
}
