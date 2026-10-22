import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { listIntegrations } from "@/contexts/integrations/application/integration-management";
import { MANAGED_PROVIDERS } from "@/contexts/integrations/domain/providers";
import { aiIsOn } from "@/contexts/integrations/domain/ai-status";
import { aiStatus, integrationDeps } from "@/contexts/integrations/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { IntegrationsPanel } from "./integrations-panel";
import { AdminNotice } from "../admin-notice";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <Integrations />
      </Suspense>
    </div>
  );
}

async function Integrations() {
  await connection();
  const ctx = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.role)) return <AdminNotice action="see or change integrations" replacesPage />;
  const [accounts, status] = await Promise.all([listIntegrations(integrationDeps(), toActor(ctx)), aiStatus(toActor(ctx).organizationId)]);
  const providers = MANAGED_PROVIDERS.map((p) => ({ key: p.key, label: p.label, description: p.description, fields: p.fields }));
  return <IntegrationsPanel accounts={JSON.parse(JSON.stringify(accounts))} providers={providers} aiOn={aiIsOn(status)} />;
}
