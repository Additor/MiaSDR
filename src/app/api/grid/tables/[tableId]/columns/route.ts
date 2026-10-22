import { createColumn, listColumns } from "@/contexts/grid/application/column-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { idField, idParam, readJsonObject } from "../../../http";

export async function GET(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns">) {
  const { tableId } = await ctx.params;
  return withActor((actor) => listColumns(gridDeps(), actor, idParam(tableId)));
}

/** Body `{ name, type, config?, autoRun?, afterColumnId?, beforeColumnId?, copyValuesFrom? }`. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    if (body.autoRun !== undefined && typeof body.autoRun !== "boolean") throw new ValidationError("autoRun must be true or false");
    if (body.copyValuesFrom !== undefined && (typeof body.copyValuesFrom !== "string" || !body.copyValuesFrom)) throw new ValidationError("copyValuesFrom must be a column key");
    return createColumn(gridDeps(), actor, id, {
      name: body.name,
      type: body.type,
      config: body.config ?? undefined,
      autoRun: body.autoRun as boolean | undefined,
      afterColumnId: body.afterColumnId === undefined ? undefined : idField(body.afterColumnId, "afterColumnId"),
      beforeColumnId: body.beforeColumnId === undefined ? undefined : idField(body.beforeColumnId, "beforeColumnId"),
      copyValuesFrom: body.copyValuesFrom as string | undefined,
    });
  }, 201);
}
