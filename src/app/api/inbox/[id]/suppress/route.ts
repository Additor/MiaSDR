import { suppressSender } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/inbox/[id]/suppress">) {
  const { id } = await ctx.params;
  return withActor((actor) => suppressSender(replyDeps(), actor, id));
}
