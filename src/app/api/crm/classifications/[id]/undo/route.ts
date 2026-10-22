import { undoClassification } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(_request: Request, ctx: RouteContext<"/api/crm/classifications/[id]/undo">) {
  const { id } = await ctx.params;
  return withActor((actor) => undoClassification(crmDeps(), actor, id));
}
