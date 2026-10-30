import { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import pkg from "../../../../../package.json";

/** How long a client may reuse the tool list. A mode change or a revoke still applies at the next call. */
export const TOOL_LIST_TTL_MS = 300_000;

/**
 * One server per request, built for the principal: the tools it registers depend on the token's scopes and the
 * person's role, so a token sees only what it may call. Each tool runs through `runTool` (`src/app/_lib/mcp.ts`).
 * Phase 0 registers no tools; the endpoint answers discovery and authentication only.
 */
export function createMcpServer(principal: McpPrincipal): McpServer {
  void principal;
  return new McpServer(
    { name: "miasdr", version: pkg.version },
    { cacheHints: { "tools/list": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "private" } } },
  );
}
