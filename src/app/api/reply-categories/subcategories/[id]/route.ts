import { z } from "zod";
import { deleteSubcategory, updateSubcategory } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/reply-categories/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await updateSubcategory(replyHandlingDeps(), actor, id, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/reply-categories/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteSubcategory(replyHandlingDeps(), actor, id);
    return { ok: true };
  });
}
