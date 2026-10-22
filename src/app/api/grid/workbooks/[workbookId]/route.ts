import { deleteWorkbook, getWorkbook, updateWorkbook } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { withActor } from "@/app/_lib/api";
import { idParam, nullableIdField, readJsonObject } from "../../http";

export async function GET(_request: Request, ctx: RouteContext<"/api/grid/workbooks/[workbookId]">) {
  const { workbookId } = await ctx.params;
  return withActor((actor) => getWorkbook(gridDeps(), actor, idParam(workbookId)));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/grid/workbooks/[workbookId]">) {
  const { workbookId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(workbookId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return updateWorkbook(gridDeps(), actor, id, { name: body.name, description: body.description, folderId: nullableIdField(body.folderId, "folderId") });
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/grid/workbooks/[workbookId]">) {
  const { workbookId } = await ctx.params;
  return withActor((actor) => deleteWorkbook(gridDeps(), actor, idParam(workbookId)));
}
