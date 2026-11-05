import { withActor } from "@/app/_lib/api";
import { dismissSuggestion } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

export async function POST(_request: Request, ctx: RouteContext<"/api/mia/suggestions/[id]/dismiss">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await dismissSuggestion(miaDeps(), actor, id);
    return { ok: true };
  });
}
