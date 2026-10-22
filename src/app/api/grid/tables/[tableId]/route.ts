import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { getTablePage } from "@/contexts/grid/application/row-management";
import { deleteTable, updateTable } from "@/contexts/grid/application/structure-management";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idField, idParam, intParam, readJsonObject } from "../../http";

/**
 * The table, its columns and one page of rows with the saved filters and sorts applied. `?search=` narrows
 * further and is not saved. `coverage` (fill rate per column, a full scan) comes with the first page only; `?coverage=0` leaves it out. `total` is the filtered count, `unfilteredTotal` the whole table, and `cursor`
 * starts polling `changes`.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]">) {
  const { tableId } = await ctx.params;
  const params = new URL(request.url).searchParams;
  return withActor((actor) =>
    getTablePage(gridDeps(), actor, idParam(tableId), {
      limit: intParam(params.get("limit"), "limit", GRID_LIMITS.defaultPageSize, { min: 1, max: GRID_LIMITS.pageSize }),
      offset: intParam(params.get("offset"), "offset", 0),
      search: params.get("search") ?? undefined,
      coverage: params.get("coverage") !== "0",
    }),
  );
}

/** Body `{ name?, description?, autoRun?, view?, workbookId? }`. `workbookId` moves the table first. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    const deps = gridDeps();
    return updateTable(deps, actor, id, {
      name: body.name,
      description: body.description,
      autoRun: body.autoRun,
      view: body.view,
      workbookId: body.workbookId === undefined ? undefined : idField(body.workbookId, "workbookId"),
    });
  });
}

/** Columns, rows, jobs and cell runs go with the table. The last table of a workbook cannot be deleted. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]">) {
  const { tableId } = await ctx.params;
  return withActor((actor) => deleteTable(gridDeps(), actor, idParam(tableId)));
}
