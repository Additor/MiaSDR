import { revokeMcpToken } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { withActor } from "@/app/_lib/api";

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/settings/mcp/tokens/[id]">) => {
  const { id } = await params;
  return withActor((actor) => revokeMcpToken(mcpTokenDeps(), actor, id));
};
