import { dedupeColumn } from "@/contexts/grid/application/column-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam } from "../../../../../http";

/** Deletes rows whose value in this column repeats an earlier row's. The first one stays. Blank values are kept. */
export async function POST(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns/[columnId]/dedupe">) {
  const { tableId, columnId } = await ctx.params;
  return withActor((actor) => dedupeColumn(gridDeps(), actor, idParam(tableId), idParam(columnId)));
}
