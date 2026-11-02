import { listMemberChoices } from "@/contexts/tenancy/application/member-directory";
import { memberDirectoryDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ResponsibleUseNote } from "@/components/shell/responsible-use-note";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isLocalOrigin, listLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { env } from "@/shared/env";
import { getOrgTimeZone } from "@/components/shell/org-time-zone";
import { timeZoneOptions } from "../time-zone-options";
import { LinkedInPanel } from "./linkedin-panel";

export const metadata: Metadata = { title: "LinkedIn" };

export default function LinkedInSettingsPage() {
  return (
    <div className="stack-section max-w-3xl">
      <ResponsibleUseNote kind="linkedin" />
      <Suspense fallback={<PageSkeleton shape="form" />}>
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
  const [state, orgTimeZone, members] = await Promise.all([
    canManage ? listLinkedInAccounts(linkedinManagementDeps(), toActor(ctx)) : null,
    getOrgTimeZone(),
    canManage ? listMemberChoices(memberDirectoryDeps(), toActor(ctx)) : [],
  ]);
  const zones = timeZoneOptions(Intl.supportedValuesOf("timeZone"), orgTimeZone);
  for (const account of state?.accounts ?? []) if (account.workingHours && !zones.includes(account.workingHours.timeZone)) zones.push(account.workingHours.timeZone);
  return <LinkedInPanel state={state ? JSON.parse(JSON.stringify(state)) : null} canManage={canManage} zones={zones} members={members} ownerOnConnect={!isLocalOrigin(env().APP_URL)} />;
}
