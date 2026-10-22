import { deleteFolder, getFolder, updateFolder } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { withActor } from "@/app/_lib/api";
import { idParam, nullableIdField, readJsonObject } from "../../http";

export async function GET(_request: Request, ctx: RouteContext<"/api/grid/folders/[folderId]">) {
  const { folderId } = await ctx.params;
  return withActor((actor) => getFolder(gridDeps(), actor, idParam(folderId)));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/grid/folders/[folderId]">) {
  const { folderId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(folderId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return updateFolder(gridDeps(), actor, id, { name: body.name, parentId: nullableIdField(body.parentId, "parentId") });
  });
}

/** Deletes the folder and its subfolders. Workbooks inside move to the root. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/grid/folders/[folderId]">) {
  const { folderId } = await ctx.params;
  return withActor((actor) => deleteFolder(gridDeps(), actor, idParam(folderId)));
}
