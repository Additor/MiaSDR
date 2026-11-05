import { withActor } from "@/app/_lib/api";
import { cancelRun } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

export async function POST(_request: Request, ctx: RouteContext<"/api/mia/runs/[id]/cancel">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await cancelRun(miaDeps(), actor, id);
    return { ok: true };
  });
}
