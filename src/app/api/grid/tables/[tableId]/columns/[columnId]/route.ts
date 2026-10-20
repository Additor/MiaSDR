import { deleteColumn, updateColumn } from "@/contexts/grid/application/column-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/shared/api";
import { idParam, nullableIdField, readJsonObject } from "../../../../http";

/** Body `{ name?, type?, config?, autoRun?, afterColumnId? }`. A static to static type change converts the stored values. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns/[columnId]">) {
  const { tableId, columnId } = await ctx.params;
  return withActor(async (actor) => {
    const table = idParam(tableId);
    const column = idParam(columnId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    if (body.autoRun !== undefined && typeof body.autoRun !== "boolean") throw new ValidationError("autoRun must be true or false");
    return updateColumn(gridDeps(), actor, table, column, {
      name: body.name,
      type: body.type,
      config: body.config,
      autoRun: body.autoRun as boolean | undefined,
      afterColumnId: nullableIdField(body.afterColumnId, "afterColumnId"),
    });
  });
}

/** `?withOutputs=1` also deletes the columns an AI or enrichment column writes into. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns/[columnId]">) {
  const { tableId, columnId } = await ctx.params;
  const flag = new URL(request.url).searchParams.get("withOutputs");
  return withActor((actor) => deleteColumn(gridDeps(), actor, idParam(tableId), idParam(columnId), { withOutputs: flag === "1" || flag === "true" }));
}

