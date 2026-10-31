import { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { hasScope } from "@/contexts/tenancy/domain/mcp-policy";
import { takeMcpRequest } from "@/contexts/tenancy/application/mcp-rate-limit";
import { recordMcpToolCall } from "@/contexts/tenancy/application/mcp-tool-calls";
import { mcpRateLimitDeps, mcpToolCallDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import pkg from "../../../../../package.json";
import { draftCampaignTool } from "./campaign-drafts";
import { getCampaignTool, listCampaignsTool } from "./campaigns";
import { getConversationTool } from "./conversation";
import { updateDealTool } from "./deals";
import { registerTools, type ToolDefinition, type ToolHooks } from "./define";
import { setReplyTypeTool, updateConversationTool } from "./handling";
import { importLeadsTool } from "./import";
import { listInboxTool } from "./inbox";
import { serverInstructions } from "./instructions";
import { pauseSendingTool } from "./pause";
import { getPersonTool, searchPeopleTool } from "./people";
import { getPipelineTool } from "./pipeline";
import { writeReplyDraftTool } from "./reply-draft";
import { getAnalyticsTool, getSendingHealthTool } from "./reports";
import { sendReplyTool } from "./send-reply";
import { manageTaskTool } from "./tasks";
import { getWorkQueueTool } from "./work-queue";
import { getWorkspace } from "./workspace";

/** How long a client may reuse the tool list. A mode change or a revoke still applies at the next call. */
export const TOOL_LIST_TTL_MS = 300_000;

/** Every tool. `registerTools` keeps the ones the token's scopes and the send policy allow. */
export const TOOLS: readonly ToolDefinition[] = [
  getWorkspace,
  getWorkQueueTool,
  listInboxTool,
  getConversationTool,
  searchPeopleTool,
  getPersonTool,
  listCampaignsTool,
  getCampaignTool,
  getAnalyticsTool,
  getPipelineTool,
  getSendingHealthTool,
  writeReplyDraftTool,
  setReplyTypeTool,
  updateConversationTool,
  manageTaskTool,
  pauseSendingTool,
  draftCampaignTool,
  updateDealTool,
  importLeadsTool,
  sendReplyTool,
];

/**
 * One server per request, built for the principal: the tools it registers depend on the token's scopes, so a token
 * sees only what it may call. Each tool runs through `runTool` (`src/app/_lib/mcp.ts`).
 */
export function createMcpServer(principal: McpPrincipal, appUrl: string): McpServer {
  const server = new McpServer(
    { name: "miasdr", version: pkg.version },
    { instructions: serverInstructions(accessOf(principal)), cacheHints: { "tools/list": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "private" } } },
  );
  registerTools(server, principal, appUrl, TOOLS, toolHooks(principal));
  return server;
}

const accessOf = (principal: McpPrincipal) => {
  if (principal.send.replies || principal.send.campaigns) return "send";
  return hasScope(principal.scopes, "mcp:write") ? "write" : "read";
};

const toolHooks = (principal: McpPrincipal): ToolHooks => ({
  take: async (bucket) => (await takeMcpRequest(mcpRateLimitDeps(), principal, bucket))?.retryAfterSeconds ?? null,
  record: (entry) => recordMcpToolCall(mcpToolCallDeps(), entry),
  now: () => performance.now(),
});
