import { z } from "zod";
import { deleteDealStage, renameDealStage } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { withActor } from "@/app/_lib/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/deal-stages/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => renameDealStage(dealsDeps(), actor, id, z.object({ name: z.string().max(200) }).parse(await request.json())));
}

/** 409 `stage_in_use` (with `count`) while deals sit in the stage; 409 `last_of_kind` for the only stage of its kind. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/deal-stages/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => deleteDealStage(dealsDeps(), actor, id));
}
