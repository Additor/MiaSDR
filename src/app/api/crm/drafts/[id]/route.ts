import { z } from "zod";
import { editDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/shared/api";

/** Same use case as PATCH /api/drafts/[id]. The edit bumps the revision a later approval must name. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/crm/drafts/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ revision: z.number().int().min(1), subject: z.string().max(998).nullable().optional(), bodyText: z.string().max(100_000), cc: z.array(z.string().max(320)).max(50).optional() }).parse(await request.json());
    return editDraft(replyDeps(), actor, id, body);
  });
}
