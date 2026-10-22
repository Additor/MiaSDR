import { generateFormula } from "@/contexts/grid/application/formula-management";
import { GRID_LIMITS } from "@/contexts/grid/application/limits";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { idParam, readJsonObject } from "../../../http";

/** Body `{ prompt, currentExpression? }`. Answers 409 when the organization has no AI provider configured. */
export async function POST(request: Request, ctx: RouteContext<"/api/grid/tables/[tableId]/formula-generate">) {
  const { tableId } = await ctx.params;
  return withActor(async (actor) => {
    const id = idParam(tableId);
    const body = await readJsonObject(request, GRID_LIMITS.jsonBodyBytes);
    return generateFormula(gridDeps(), actor, id, { prompt: body.prompt, currentExpression: body.currentExpression });
  });
}
