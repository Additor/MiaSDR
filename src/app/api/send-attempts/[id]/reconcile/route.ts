import { z } from "zod";
import { reconcileSendAttempt } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/** A person's call on a reply whose delivery the provider never confirmed. Records the outcome; nothing is resent. */
export async function POST(request: Request, ctx: RouteContext<"/api/send-attempts/[id]/reconcile">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ delivered: z.boolean(), note: z.string().min(1).max(1000) }).parse(await request.json());
    await reconcileSendAttempt(replyHandlingDeps(), replyDeps(), actor, id, body);
    return { ok: true };
  });
}
