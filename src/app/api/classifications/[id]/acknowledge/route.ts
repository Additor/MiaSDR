import { acknowledgeReplyTypePick } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/classifications/[id]/acknowledge">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await acknowledgeReplyTypePick(replyHandlingDeps(), actor, id);
    return { ok: true };
  });
}
