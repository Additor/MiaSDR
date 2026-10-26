import { undoReplyTypePick } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/reply-type-picks/[id]/undo">) {
  const { id } = await ctx.params;
  return withActor((actor) => undoReplyTypePick(replyHandlingDeps(), actor, id));
}
