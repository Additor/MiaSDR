import { textToColumns } from "@/contexts/grid/application/column-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam, readJsonObject } from "../../../../../http";

/** Body `{ delimiter: "comma" | "space" | "semicolon" | "pipe" }`. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/columns/[columnId]/text-to-columns">) {
  const { tableId, columnId } = await ctx.params;
  return withActor(async (actor) => {
    const table = idParam(tableId);
    const column = idParam(columnId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return textToColumns(gridDeps(), actor, table, column, body.delimiter);
  });
}
