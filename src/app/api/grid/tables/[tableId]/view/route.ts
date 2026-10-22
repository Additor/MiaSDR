import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { resetMyView, saveMyView } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam, readJsonObject } from "../../../http";

/**
 * Body `{ view }`: the whole view the member now sees (hiddenColumns, sorts, filters). The keys that differ from
 * the table's default are stored for this member only. Answers `{ view, defaultView, personal, canEditDefault }`.
 * The default itself changes through `PATCH /api/grid/tables/[tableId]` (owner or admin).
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/view">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return saveMyView(gridDeps(), actor, id, body.view);
  });
}

/** Drops the member's own view, so the table's default applies again. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/view">) {
  const { tableId } = await ctx.params;
  return withActor((actor) => resetMyView(gridDeps(), actor, idParam(tableId)));
}
