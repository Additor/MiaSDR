import { getCrmRecord } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export async function GET(_request: Request, ctx: RouteContext<"/api/crm/records/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getCrmRecord(crmDeps(), actor, id));
}
