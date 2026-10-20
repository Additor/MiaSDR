import { z } from "zod";
import { approveAndSendDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/shared/api";

const bodySchema = z.object({ revision: z.number().int().min(1), idempotencyKey: z.string().min(8).max(200) });

/** Approval by a signed-in member. The body names the revision the person reviewed and a client-made key, so a double click sends once. */
export async function POST(request: Request, ctx: RouteContext<"/api/drafts/[id]/send">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = bodySchema.parse(await request.json());
    return approveAndSendDraft(replyDeps(), actor, id, body);
  });
}
