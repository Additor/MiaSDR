import { z } from "zod";
import { deleteReplyType, updateReplyType } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withAdmin } from "@/app/_lib/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/reply-categories/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await updateReplyType(replyHandlingDeps(), actor, id, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/reply-categories/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await deleteReplyType(replyHandlingDeps(), actor, id);
    return { ok: true };
  });
}
