import { McpServer } from "@modelcontextprotocol/server";
import { clientNameFrom } from "@/app/_lib/mcp";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { hasScope } from "@/contexts/tenancy/domain/mcp-policy";
import { takeMcpRequest } from "@/contexts/tenancy/application/mcp-rate-limit";
import { callTarget, recordMcpToolCall } from "@/contexts/tenancy/application/mcp-tool-calls";
import { mcpRateLimitDeps, mcpToolCallDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import pkg from "../../../../../package.json";
import { draftCampaignTool } from "./campaign-drafts";
import { UI_EXTENSION } from "./cards";
import { launchCampaignTool, previewCampaignLaunchTool } from "./campaign-launch";
import { getCampaignTool, listCampaignsTool } from "./campaigns";
import { getConversationTool } from "./conversation";
import { updateDealTool } from "./deals";
import { registerTools, toolVisible, type ToolDefinition, type ToolHooks } from "./define";
import { setReplyTypeTool, updateConversationTool } from "./handling";
import { importLeadsTool } from "./import";
import { listInboxTool } from "./inbox";
import { applyIrreversibleTool, previewIrreversibleTool } from "./irreversible";
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

/** Every tool. `registerTools` keeps the ones the token's scopes and the policies allow. */
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
  previewCampaignLaunchTool,
  launchCampaignTool,
  previewIrreversibleTool,
  applyIrreversibleTool,
];

/**
 * One server per request, built for the principal: the tools it registers depend on the token's scopes, so a token
 * sees only what it may call. Each tool runs through `runTool` (`src/app/_lib/mcp.ts`).
 */
export function createMcpServer(principal: McpPrincipal, appUrl: string, connectionClient: string | null = null): McpServer {
  const server = new McpServer(
    { name: "miasdr", version: pkg.version },
    { instructions: serverInstructions(accessOf(principal)), capabilities: { extensions: { [UI_EXTENSION]: {} } }, cacheHints: { "tools/list": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "private" } } },
  );
  registerTools(server, principal, appUrl, TOOLS, toolHooks(principal), connectionClient);
  return server;
}

/**
 * The SDK answers a call to a tool this token cannot see, or with input the tool's schema refuses, before any tool
 * runs. Those calls still belong in the activity log, so the route shows the request here first. Anything else is left
 * for the SDK and for `registerTools`, which logs the calls it runs.
 */
export async function recordRefusedCall(principal: McpPrincipal, body: string, connectionClient: string | null = null): Promise<void> {
  let message: { method?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: unknown } } | null;
  try {
    message = JSON.parse(body);
  } catch {
    return;
  }
  if (message?.method !== "tools/call" || typeof message.params?.name !== "string") return;
  const { name, arguments: args, _meta } = message.params;
  const tool = TOOLS.find((t) => t.name === name && toolVisible(t, principal));
  if (tool && tool.input.safeParse(args ?? {}).success) return;
  await recordMcpToolCall(mcpToolCallDeps(), {
    organizationId: principal.organizationId,
    tokenId: principal.tokenId,
    tool: name.slice(0, 100),
    action: null,
    kind: tool && !tool.annotations.readOnlyHint ? "write" : "read",
    target: callTarget(args),
    errorCode: tool ? "invalid_input" : "unknown_tool",
    clientName: clientNameFrom(_meta) ?? connectionClient,
    durationMs: 0,
  }).catch((cause) => console.error(`[mcp] could not log a refused call for organization ${principal.organizationId}`, cause));
}

const accessOf = (principal: McpPrincipal) => {
  if (principal.allows.replies || principal.allows.campaigns) return "send";
  return hasScope(principal.scopes, "mcp:write") ? "write" : "read";
};

const toolHooks = (principal: McpPrincipal): ToolHooks => ({
  take: async (bucket) => (await takeMcpRequest(mcpRateLimitDeps(), principal, bucket))?.retryAfterSeconds ?? null,
  record: (entry) => recordMcpToolCall(mcpToolCallDeps(), entry),
  now: () => performance.now(),
});
