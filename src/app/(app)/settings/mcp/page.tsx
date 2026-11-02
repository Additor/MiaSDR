import { agentSendsOverview } from "@/read-models/agent-sends";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { mcpOAuthAvailable } from "@/contexts/identity/domain/mcp-oauth";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getMcpSettings, listMcpTokens } from "@/contexts/tenancy/application/mcp-tokens";
import { listMcpToolCalls } from "@/contexts/tenancy/application/mcp-tool-calls";
import { MCP_TOKEN_DAYS, MCP_TOKEN_LIMIT } from "@/contexts/tenancy/domain/mcp-token";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { mcpTokenDeps, mcpToolCallDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { toActor } from "@/app/_lib/api";
import { env } from "@/shared/env";
import { McpPanel } from "./mcp-panel";

export const metadata: Metadata = { title: "AI agents (MCP)" };

export default function McpPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Mcp />
      </Suspense>
    </div>
  );
}

async function Mcp() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const deps = mcpTokenDeps();
  const canManage = isOwnerOrAdmin(ctx.role);
  const [settings, mine, everyone, activity] = await Promise.all([
    getMcpSettings(deps, actor),
    listMcpTokens(deps, actor, "mine"),
    canManage ? listMcpTokens(deps, actor, "organization") : Promise.resolve([]),
    canManage ? listMcpToolCalls(mcpToolCallDeps(), actor, { writesOnly: true, before: null }) : Promise.resolve(null),
  ]);
  // What agents sent and started; owners and admins only.
  const sends = canManage ? await agentSendsOverview(actor.organizationId, new Date()) : null;
  const { MCP_ENABLED, MCP_SEND_ENABLED, MCP_SPEND_ENABLED, MCP_IRREVERSIBLE_ENABLED, APP_URL, RETENTION_MCP_TOOL_CALLS_DAYS } = env();
  return (
    <McpPanel
      oauthAvailable={mcpOAuthAvailable(APP_URL, MCP_ENABLED)}
      installEnabled={MCP_ENABLED}
      enabled={settings.enabled}
      memberWriteTokens={settings.memberWriteTokens}
      agentSendMode={MCP_SEND_ENABLED ? settings.agentSendMode : "off"}
      agentSpends={MCP_SPEND_ENABLED && (settings.agentSpendCentsPerDay > 0 || settings.agentSearchLeadsPerDay > 0)}
      agentIrreversible={MCP_IRREVERSIBLE_ENABLED && settings.agentIrreversiblePerDay > 0}
      canManage={canManage}
      currentUserId={ctx.user.id}
      endpoint={`${APP_URL}/api/mcp`}
      tokenDays={MCP_TOKEN_DAYS}
      tokenLimit={MCP_TOKEN_LIMIT}
      mine={JSON.parse(JSON.stringify(mine))}
      everyone={JSON.parse(JSON.stringify(everyone))}
      activity={activity && JSON.parse(JSON.stringify(activity))}
      activityDays={RETENTION_MCP_TOOL_CALLS_DAYS}
      agentSends={sends && JSON.parse(JSON.stringify({ ...sends, limits: { replies: settings.agentReplyCaps.org, user: settings.agentReplyCaps.user, mailbox: settings.agentReplyCaps.mailbox, enrolls: settings.agentEnrollCap } }))}
    />
  );
}
