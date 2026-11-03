import { z } from "zod";
import { discardDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/drafts/[id]/discard">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ revision: z.number().int().min(1) }).parse(await request.json().catch(() => ({})));
    await discardDraft(replyDeps(), actor, id, { expectedRevision: body.revision });
    return { ok: true };
  });
}
