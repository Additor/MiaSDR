import { z } from "zod";
import { addConversationNote } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/conversations/[id]/notes">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => addConversationNote(replyHandlingDeps(), actor, id, z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json())), 201);
}
