import { markConversationRead } from "@/contexts/conversations/application/inbox";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/inbox/[id]/read">) {
  const { id } = await ctx.params;
  return withActor((actor) => markConversationRead(inboxDeps(), actor, id));
}
