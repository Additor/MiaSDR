import { z } from "zod";
import { deleteCrmSubcategory, updateCrmSubcategory } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/crm/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await updateCrmSubcategory(crmDeps(), actor, id, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/crm/subcategories/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteCrmSubcategory(crmDeps(), actor, id);
    return { ok: true };
  });
}
