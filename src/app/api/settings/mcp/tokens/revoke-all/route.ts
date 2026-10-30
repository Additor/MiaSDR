import { revokeAllMcpTokens } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { withAdmin } from "@/app/_lib/api";

export const POST = () => withAdmin("Only an owner or admin can revoke every MCP token.", (actor) => revokeAllMcpTokens(mcpTokenDeps(), actor));
