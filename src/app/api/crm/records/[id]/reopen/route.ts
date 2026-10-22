import { reopenCrmRecord } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/crm/records/[id]/reopen">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await reopenCrmRecord(crmDeps(), actor, id);
    return { ok: true };
  });
}
