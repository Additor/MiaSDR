import { revokeAllMcpTokens } from "@/contexts/agent-access/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/agent-access/infrastructure/mcp-composition";
import { withAdmin } from "@/app/_lib/api";

export const POST = () => withAdmin("Only an owner or admin can revoke every MCP token.", (actor) => revokeAllMcpTokens(mcpTokenDeps(), actor));
