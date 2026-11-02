import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../../auth-skeleton";
import { toActor } from "@/app/_lib/api";
import { mcpOAuthAvailable } from "@/contexts/identity/domain/mcp-oauth";
import { oauthClientFor } from "@/contexts/identity/infrastructure/mcp-oauth";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { grantableAccess, type McpTokenAccess } from "@/contexts/tenancy/application/mcp-tokens";
import { listMyOrganizations } from "@/contexts/tenancy/application/organization-switching";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { switchingDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { env } from "@/shared/env";
import { ConsentForm } from "./consent-form";

export const metadata: Metadata = { title: "Connect an app" };

const LEVELS: Array<{ access: McpTokenAccess; scope: string }> = [
  { access: "read", scope: "mcp:read" },
  { access: "write", scope: "mcp:write" },
  { access: "send", scope: "mcp:send" },
];

export default function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <Consent searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function Consent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { APP_URL, MCP_ENABLED, MCP_SEND_ENABLED } = env();
  if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED)) notFound();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const params = await searchParams;
  const clientId = one(params.client_id);
  const client = await oauthClientFor(clientId, await headers());
  const deps = mcpTokenDeps();
  const settings = await deps.store.settings(actor.organizationId);
  const requested = one(params.scope).split(" ");
  // A client that names no MCP scope gets reading, the least it can do anything with.
  const asked = LEVELS.filter((level) => requested.includes(level.scope)).map((level) => level.access);
  const allowed = grantableAccess(settings, actor.role, MCP_SEND_ENABLED);
  const choices = (asked.length > 0 ? asked : (["read"] as McpTokenAccess[])).filter((access) => allowed.includes(access));
  const { organizations } = await listMyOrganizations(switchingDeps(), { userId: actor.userId, activeOrganizationId: actor.organizationId });
  // A metadata document proves the app controls its address. A self-registered app wrote its own name.
  const verifiedHost = clientId.startsWith("https://") ? hostOf(clientId) : null;
  return (
    <ConsentForm
      clientName={client?.client_name ?? "An app"}
      found={client !== null}
      verifiedHost={verifiedHost}
      redirectHost={hostOf(one(params.redirect_uri))}
      mcpOn={settings.enabled}
      choices={choices}
      organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
      organizationId={actor.organizationId}
    />
  );
}
