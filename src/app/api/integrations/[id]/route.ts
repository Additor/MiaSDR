import { deleteIntegration } from "@/contexts/integrations/application/integration-management";
import { integrationDeps } from "@/contexts/integrations/infrastructure/composition";
import { withActor } from "@/shared/api";

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/integrations/[id]">) => {
  const { id } = await params;
  return withActor((actor) => deleteIntegration(integrationDeps(), actor, id));
};
