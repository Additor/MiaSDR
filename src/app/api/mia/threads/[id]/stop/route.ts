import { withActor } from "@/app/_lib/api";
import { stopAnswer } from "@/contexts/mia/application/chat-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";

/** Stops the answer being written in the chat. What it wrote so far stays. */
export async function POST(_request: Request, ctx: RouteContext<"/api/mia/threads/[id]/stop">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await stopAnswer(miaChatDeps(), actor, id);
    return { ok: true };
  });
}
