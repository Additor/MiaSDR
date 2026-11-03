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
import { consentChoices, consentExtras } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { env } from "@/shared/env";
import { ConsentForm } from "./consent-form";

export const metadata: Metadata = { title: "Connect an app" };

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
  const { APP_URL, MCP_ENABLED, MCP_SEND_ENABLED, MCP_SPEND_ENABLED, MCP_IRREVERSIBLE_ENABLED } = env();
  if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED)) notFound();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const params = await searchParams;
  const clientId = one(params.client_id);
  const client = await oauthClientFor(clientId, await headers());
  const deps = mcpTokenDeps();
  const settings = await deps.store.settings(actor.organizationId);
  const choices = consentChoices(settings, actor.role, MCP_SEND_ENABLED, one(params.scope));
  const extras = consentExtras(settings, actor.role, { spend: MCP_SPEND_ENABLED, irreversible: MCP_IRREVERSIBLE_ENABLED }, one(params.scope));
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
      extras={extras}
      organizationName={ctx.organization.name}
    />
  );
}
