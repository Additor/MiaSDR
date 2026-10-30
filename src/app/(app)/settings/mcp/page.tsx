import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getMcpSettings, listMcpTokens } from "@/contexts/tenancy/application/mcp-tokens";
import { MCP_TOKEN_DAYS, MCP_TOKEN_LIMIT } from "@/contexts/tenancy/domain/mcp-token";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
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
  const [settings, mine, everyone] = await Promise.all([
    getMcpSettings(deps, actor),
    listMcpTokens(deps, actor, "mine"),
    canManage ? listMcpTokens(deps, actor, "organization") : Promise.resolve([]),
  ]);
  const { MCP_ENABLED, APP_URL } = env();
  return (
    <McpPanel
      installEnabled={MCP_ENABLED}
      enabled={settings.enabled}
      canManage={canManage}
      currentUserId={ctx.user.id}
      endpoint={`${APP_URL}/api/mcp`}
      tokenDays={MCP_TOKEN_DAYS}
      tokenLimit={MCP_TOKEN_LIMIT}
      mine={JSON.parse(JSON.stringify(mine))}
      everyone={JSON.parse(JSON.stringify(everyone))}
    />
  );
}
