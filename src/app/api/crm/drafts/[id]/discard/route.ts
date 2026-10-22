import { discardDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/crm/drafts/[id]/discard">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await discardDraft(replyDeps(), actor, id);
    return { ok: true };
  });
}
