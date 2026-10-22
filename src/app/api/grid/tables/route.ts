import { createTable, listTables } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { ValidationError } from "@/shared/errors";
import { withActor } from "@/app/_lib/api";
import { idField, readJsonObject } from "../http";

export function GET(request: Request) {
  const workbookId = new URL(request.url).searchParams.get("workbookId");
  return withActor((actor) => {
    if (!workbookId) throw new ValidationError("workbookId is required");
    return listTables(gridDeps(), actor, idField(workbookId, "workbookId"));
  });
}

export function POST(request: Request) {
  return withActor(async (actor) => {
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return createTable(gridDeps(), actor, { workbookId: idField(body.workbookId, "workbookId"), name: body.name, description: body.description });
  }, 201);
}
