import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { isOwnerOrAdmin, parseRoles } from "@/contexts/tenancy/domain/roles";
import { getSendPause } from "@/contexts/outreach/application/send-pause";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { AdminNotice } from "../admin-notice";
import { timeZoneOptions } from "../time-zone-options";
import { OrganizationForm } from "./organization-form";
import { getMcpSettings } from "@/contexts/agent-access/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/agent-access/infrastructure/mcp-composition";
import { getMiaSettings, miaUsedToday } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";
import { env } from "@/shared/env";
import { AgentActionsSection } from "./agent-actions-section";
import { AgentSendSection } from "./agent-send-section";
import { MiaSection } from "./mia-section";
import { SendPauseSection } from "./send-pause-section";

export const metadata: Metadata = { title: "Organization" };

export default function OrganizationPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Organization />
      </Suspense>
    </div>
  );
}

async function Organization() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const [org, pause, mcp, mia, miaUsed] = await Promise.all([getOrganization(organizationDeps(), actor), getSendPause(emailRulesDeps(), actor), getMcpSettings(mcpTokenDeps(), actor), getMiaSettings(miaDeps(), actor), miaUsedToday(miaDeps(), actor)]);
  const { MCP_ENABLED, MCP_SEND_ENABLED, MCP_SPEND_ENABLED, MCP_IRREVERSIBLE_ENABLED, MIA_ENABLED } = env();
  const zones = timeZoneOptions(Intl.supportedValuesOf("timeZone"), org.timeZone);
  const canEditZone = isOwnerOrAdmin(ctx.role);
  return (
    <>
      {!canEditZone && (
        <div className="pb-section">
          <AdminNotice action="change these settings" />
        </div>
      )}
      <OrganizationForm
        org={{ name: org.name, slug: org.slug, timeZone: org.timeZone, defaultPhoneCountry: org.defaultPhoneCountry }}
        zones={zones}
        canRename={parseRoles(ctx.role).includes("owner")}
        canEditZone={canEditZone}
      />
      <SendPauseSection pause={pause} canManage={canEditZone} />
      <MiaSection settings={mia} usedToday={miaUsed} installEnabled={MIA_ENABLED} canManage={canEditZone} />
      {/* Agents reach MiaSDR only through MCP, so the card shows only where MCP runs. */}
      {MCP_ENABLED && mcp.enabled && (
        <AgentSendSection
          settings={{ agentSendMode: mcp.agentSendMode, agentReplyCaps: mcp.agentReplyCaps, agentEnrollCap: mcp.agentEnrollCap }}
          installEnabled={MCP_SEND_ENABLED}
          canManage={canEditZone}
        />
      )}
      {MCP_ENABLED && mcp.enabled && (
        <AgentActionsSection
          settings={{ agentSpendCentsPerDay: mcp.agentSpendCentsPerDay, agentSearchLeadsPerDay: mcp.agentSearchLeadsPerDay, agentIrreversiblePerDay: mcp.agentIrreversiblePerDay }}
          spendInstallEnabled={MCP_SPEND_ENABLED}
          irreversibleInstallEnabled={MCP_IRREVERSIBLE_ENABLED}
          canManage={canEditZone}
        />
      )}
    </>
  );
}
