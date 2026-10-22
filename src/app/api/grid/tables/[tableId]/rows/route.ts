import { addRows, deleteRows, listRows } from "@/contexts/grid/application/row-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idList, idParam, intParam, readJsonObject } from "../../../http";

export async function GET(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/rows">) {
  const { tableId } = await ctx.params;
  const params = new URL(request.url).searchParams;
  return withActor((actor) =>
    listRows(gridDeps(), actor, idParam(tableId), {
      limit: intParam(params.get("limit"), "limit", GRID_LIMITS.defaultPageSize, { min: 1, max: GRID_LIMITS.pageSize }),
      offset: intParam(params.get("offset"), "offset", 0),
    }),
  );
}

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
