import { z } from "zod";
import { resolveUncertainSend } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/** A person's call on an uncertain send, addressed by draft. `/api/crm/send-attempts/[id]/reconcile` addresses it by attempt. */
export async function POST(request: Request, ctx: RouteContext<"/api/crm/drafts/[id]/resolve">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ outcome: z.enum(["delivered", "not_delivered"]), note: z.string().min(1).max(1000) }).parse(await request.json());
    await resolveUncertainSend(replyDeps(), actor, id, body);
    return { ok: true };
  });
}
