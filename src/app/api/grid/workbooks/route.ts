import { createWorkbook, listWorkbooks } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { withActor } from "@/shared/api";
import { idField, nullableIdField, readOptionalJsonObject } from "../http";

/** `?folder=root` lists the root, `?folder=<id>` one folder, no parameter every workbook. */
export function GET(request: Request) {
  const folder = new URL(request.url).searchParams.get("folder");
  return withActor((actor) => listWorkbooks(gridDeps(), actor, folder === null ? "all" : folder === "root" ? null : idField(folder, "folder")));
}

export function POST(request: Request) {
  return withActor(async (actor) => {
    const body = await readOptionalJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return createWorkbook(gridDeps(), actor, { name: body.name, firstTableName: body.firstTableName, folderId: nullableIdField(body.folderId, "folderId") });
  }, 201);
}
