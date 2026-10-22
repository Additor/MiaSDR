import { getRecord } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function GET(_request: Request, ctx: RouteContext<"/api/records/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getRecord(replyHandlingDeps(), actor, id));
}
