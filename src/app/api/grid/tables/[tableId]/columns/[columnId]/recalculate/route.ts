import { recalculateColumn } from "@/contexts/grid/application/column-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/shared/api";
import { idParam } from "../../../../../http";

/** Recomputes a formula column for every row, so LOOKUPs pick up changes in their source tables. Clears "stale" and error markers that no longer apply. */
export async function POST(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns/[columnId]/recalculate">) {
  const { tableId, columnId } = await ctx.params;
  return withActor((actor) => recalculateColumn(gridDeps(), actor, idParam(tableId), idParam(columnId)));
}
