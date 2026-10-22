import { duplicateTable } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam } from "../../../http";

/** Copies columns, rows and finished cell values next to the original. Queued jobs and run history stay behind. */
export async function POST(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/duplicate">) {
  const { tableId } = await ctx.params;
  return withActor((actor) => duplicateTable(gridDeps(), actor, idParam(tableId)), 201);
}
