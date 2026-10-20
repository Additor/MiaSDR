import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ResponsibleUseNote } from "@/components/shell/responsible-use-note";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/shared/api";
import { LinkedInPanel } from "./linkedin-panel";

export const metadata: Metadata = { title: "LinkedIn" };

export default function LinkedInSettingsPage() {
  return (
    <div className="stack-section max-w-3xl">
      <ResponsibleUseNote kind="linkedin" />
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <LinkedIn />
      </Suspense>
    </div>
  );
}

async function LinkedIn() {
  await connection();
  const ctx = await requireOrgContext();
  const canManage = isOwnerOrAdmin(ctx.role);
  // Credentials never reach the page. Members only see that LinkedIn is connected.
  const state = canManage ? await listLinkedInAccounts(linkedinManagementDeps(), toActor(ctx)) : null;
  return <LinkedInPanel state={state ? JSON.parse(JSON.stringify(state)) : null} canManage={canManage} />;
}
