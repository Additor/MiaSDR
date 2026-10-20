import { z } from "zod";
import { updateKnowledge } from "@/contexts/conversations/ai/application/knowledge";
import { KNOWLEDGE_KINDS } from "@/contexts/conversations/ai/domain/knowledge";
import { knowledgeStore } from "@/contexts/conversations/infrastructure/composition";
import { withActor } from "@/shared/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/crm/knowledge/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z
      .object({ title: z.string().optional(), kind: z.enum(KNOWLEDGE_KINDS).optional(), content: z.string().optional(), alwaysInclude: z.boolean().optional(), tags: z.array(z.string().max(500)).max(200).optional(), active: z.boolean().optional() })
      .parse(await request.json());
    await updateKnowledge(knowledgeStore, actor, id, body);
    return { ok: true };
  });
}
