import { z } from "zod";
import { approveAndSendDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/shared/api";

const bodySchema = z.object({ revision: z.number().int().min(1), idempotencyKey: z.string().min(8).max(200) });

/** Approval by a signed-in member through `approveAndSendDraft`, the only function that holds a mailer. */
export async function POST(request: Request, ctx: RouteContext<"/api/crm/drafts/[id]/send">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => approveAndSendDraft(replyDeps(), actor, id, bodySchema.parse(await request.json())));
}
