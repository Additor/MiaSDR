import { z } from "zod";
import { updateKnowledge } from "@/contexts/brain/application/brain-items";
import { BRAIN_KINDS } from "@/contexts/brain/domain/brain-kinds";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { withAdmin } from "@/app/_lib/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/brain/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can change knowledge documents.", async (actor) => {
    const body = z
      .object({ title: z.string().optional(), kind: z.enum(BRAIN_KINDS).optional(), content: z.string().optional(), alwaysInclude: z.boolean().optional(), tags: z.array(z.string().max(500)).max(200).optional(), active: z.boolean().optional() })
      .parse(await request.json());
    await updateKnowledge(brainStore, actor, id, body);
    return { ok: true };
  });
}
