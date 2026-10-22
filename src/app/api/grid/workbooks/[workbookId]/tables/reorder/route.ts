import { reorderTables } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { withActor } from "@/app/_lib/api";
import { idList, idParam, readJsonObject } from "../../../../http";

/** Body `{ tableIds }`: every table of the workbook, in the new tab order. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/workbooks/[workbookId]/tables/reorder">) {
  const { workbookId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(workbookId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return reorderTables(gridDeps(), actor, id, idList(body.tableIds, "tableIds", GRID_LIMITS.tablesPerWorkbook));
  });
}
