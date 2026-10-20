import { z } from "zod";
import { closeCrmRecord } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

export async function POST(request: Request, ctx: RouteContext<"/api/crm/records/[id]/close">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await closeCrmRecord(crmDeps(), actor, id, z.object({ reason: z.string().min(1).max(500) }).parse(await request.json()));
    return { ok: true };
  });
}
