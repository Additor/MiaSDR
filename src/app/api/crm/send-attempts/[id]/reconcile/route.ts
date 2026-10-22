import { z } from "zod";
import { reconcileSendAttempt } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/** A person's call on a reply whose delivery the provider never confirmed. Records the outcome; nothing is resent. */
export async function POST(request: Request, ctx: RouteContext<"/api/crm/send-attempts/[id]/reconcile">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ delivered: z.boolean(), note: z.string().min(1).max(1000) }).parse(await request.json());
    await reconcileSendAttempt(crmDeps(), replyDeps(), actor, id, body);
    return { ok: true };
  });
}
