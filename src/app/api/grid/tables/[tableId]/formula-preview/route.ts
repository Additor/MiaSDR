import { previewFormula } from "@/contexts/grid/application/formula-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/shared/api";
import { idField, idParam, readJsonObject } from "../../../http";

/** Body `{ expression, rowId? }`. Evaluates against one row and writes nothing. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/formula-preview">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return previewFormula(gridDeps(), actor, id, {
      expression: body.expression,
      rowId: body.rowId === undefined || body.rowId === null ? undefined : idField(body.rowId, "rowId"),
    });
  });
}
