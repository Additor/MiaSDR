import { z } from "zod";
import { closeRecord } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/records/[id]/close">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await closeRecord(replyHandlingDeps(), actor, id, z.object({ reason: z.string().min(1).max(500) }).parse(await request.json()));
    return { ok: true };
  });
}
