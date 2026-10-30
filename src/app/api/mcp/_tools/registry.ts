import { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import pkg from "../../../../../package.json";
import { getConversationTool } from "./conversation";
import { registerTools, type ToolDefinition } from "./define";
import { listInboxTool } from "./inbox";
import { getPersonTool, searchPeopleTool } from "./people";
import { getWorkQueueTool } from "./work-queue";
import { getWorkspace } from "./workspace";

/** How long a client may reuse the tool list. A mode change or a revoke still applies at the next call. */
export const TOOL_LIST_TTL_MS = 300_000;

/** Every tool. `registerTools` keeps the ones the token's scopes allow. */
export const TOOLS: readonly ToolDefinition[] = [getWorkspace, getWorkQueueTool, listInboxTool, getConversationTool, searchPeopleTool, getPersonTool];

/**
 * One server per request, built for the principal: the tools it registers depend on the token's scopes, so a token
 * sees only what it may call. Each tool runs through `runTool` (`src/app/_lib/mcp.ts`).
 */
export function createMcpServer(principal: McpPrincipal, appUrl: string): McpServer {
  const server = new McpServer(
    { name: "miasdr", version: pkg.version },
    { cacheHints: { "tools/list": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "private" } } },
  );
  registerTools(server, principal, appUrl, TOOLS);
  return server;
}
