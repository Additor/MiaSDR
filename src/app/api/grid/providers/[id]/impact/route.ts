import { providerImpact } from "@/contexts/grid/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

/** The columns that call this provider and the cells still waiting on them, for the Turn off and Disconnect confirmation. */
export const GET = async (_request: Request, { params }: RouteContext<"/api/grid/providers/[id]/impact">) => {
  const { id } = await params;
  return withActor((actor) => providerImpact(gridRunDeps(), actor, id));
};
