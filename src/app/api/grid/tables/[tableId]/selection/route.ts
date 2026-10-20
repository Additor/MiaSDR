import { selectRows } from "@/contexts/grid/application/row-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/shared/api";
import { idParam } from "../../../http";

/** Ids of every row matching the saved filters and `?search=`. The grid holds one page, so this is the source for "select all". */
export async function GET(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/selection">) {
  const { tableId } = await ctx.params;
  const search = new URL(request.url).searchParams.get("search") ?? undefined;
  return withActor((actor) => selectRows(gridDeps(), actor, idParam(tableId), { search }));
}
