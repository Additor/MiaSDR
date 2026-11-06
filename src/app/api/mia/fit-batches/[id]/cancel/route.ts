import { withActor } from "@/app/_lib/api";
import { cancelFitBatch } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";

export async function POST(_request: Request, ctx: RouteContext<"/api/mia/fit-batches/[id]/cancel">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await cancelFitBatch(miaDeps(), actor, id);
    return { ok: true };
  });
}
