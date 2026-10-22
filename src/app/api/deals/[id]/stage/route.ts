import { moveDealStage } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/app/_lib/api";
import { moveStageSchema } from "../../validation";

/** Move stage, Mark won and Mark lost. 409 `stale_version` when the deal changed; 422 without a reason for a Lost stage. */
export async function POST(request: Request, ctx: RouteContext<"/api/deals/[id]/stage">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => moveDealStage(dealsDeps(), actor, id, moveStageSchema.parse(await request.json())));
}
