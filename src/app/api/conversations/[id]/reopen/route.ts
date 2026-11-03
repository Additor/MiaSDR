import { reopenConversation } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/conversations/[id]/reopen">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await reopenConversation(replyHandlingDeps(), actor, id);
    return { ok: true };
  });
}
