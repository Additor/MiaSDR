import { z } from "zod";
import { regenerateDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/drafts/[id]/regenerate">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ revision: z.number().int().min(1), note: z.string().max(2000).optional() }).parse(await request.json().catch(() => ({})));
    return regenerateDraft(replyDeps(), actor, id, { note: body.note, expectedRevision: body.revision });
  }, 201);
}
