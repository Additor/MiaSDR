import { getChanges } from "@/contexts/grid/application/row-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam } from "../../../http";

/**
 * Polling feed: rows written since `?cursor=` (opaque: from the table GET or the last changes call), the
 * new cursor, `hasMore`, the table's row `total` (a drop means rows were deleted, so reload) and `activeJobs`.
 * Call again at once while `hasMore` is true, since the cursor settles on the last page. Poll while
 * `activeJobs` is above zero.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/changes">) {
  const { tableId } = await ctx.params;
  const cursor = new URL(request.url).searchParams.get("cursor") ?? "0";
  return withActor((actor) => getChanges(gridDeps(), actor, idParam(tableId), cursor));
}
