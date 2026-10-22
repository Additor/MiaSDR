import { createFolder, listFolders } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { withActor } from "@/app/_lib/api";
import { idField, nullableIdField, readOptionalJsonObject } from "../http";

/** `?parent=root` lists the root, `?parent=<id>` one folder's children, no parameter every folder (move pickers). */
export function GET(request: Request) {
  const parent = new URL(request.url).searchParams.get("parent");
  return withActor((actor) => listFolders(gridDeps(), actor, parent === null ? undefined : parent === "root" ? null : idField(parent, "parent")));
}

export function POST(request: Request) {
  return withActor(async (actor) => {
    const body = await readOptionalJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return createFolder(gridDeps(), actor, { name: body.name, parentId: nullableIdField(body.parentId, "parentId") });
  }, 201);
}
