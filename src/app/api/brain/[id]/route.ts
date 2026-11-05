import { z } from "zod";
import { changeBrainItem } from "@/contexts/brain/application/brain-items";
import { brainStore } from "@/contexts/brain/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

const PATCH_ITEM = z.object({
  kind: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  alwaysInclude: z.boolean().optional(),
  tags: z.array(z.string().max(500)).max(200).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/brain/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await changeBrainItem(brainStore, actor, id, PATCH_ITEM.parse(await request.json()));
    return { ok: true };
  });
}
