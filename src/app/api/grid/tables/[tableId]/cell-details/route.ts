import { getCellDetails } from "@/contexts/grid/application/cell-details";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam } from "../../../http";

/** `?rowId=&columnKey=`: the latest recorded run behind a cell. */
export async function GET(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/cell-details">) {
  const { tableId } = await ctx.params;
  const params = new URL(request.url).searchParams;
  return withActor((actor) => getCellDetails(gridDeps(), actor, idParam(tableId, "Cell not found"), idParam(params.get("rowId") ?? "", "Cell not found"), params.get("columnKey") ?? ""));
}
