import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { isOwnerOrAdmin, parseRoles } from "@/contexts/tenancy/domain/roles";
import { getSendPause } from "@/contexts/outreach/application/send-pause";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { toActor } from "@/app/_lib/api";
import { timeZoneOptions } from "../time-zone-options";
import { OrganizationForm } from "./organization-form";
import { SendPauseSection } from "./send-pause-section";

export const metadata: Metadata = { title: "Organization" };

export default function OrganizationPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <Organization />
      </Suspense>
    </div>
  );
}

async function Organization() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const [org, pause] = await Promise.all([getOrganization(organizationDeps(), actor), getSendPause(emailRulesDeps(), actor)]);
  const zones = timeZoneOptions(Intl.supportedValuesOf("timeZone"), org.timeZone);
  return (
    <>
      <OrganizationForm
        org={{ name: org.name, slug: org.slug, timeZone: org.timeZone, defaultPhoneCountry: org.defaultPhoneCountry }}
        zones={zones}
        canRename={parseRoles(ctx.role).includes("owner")}
        canEditZone={isOwnerOrAdmin(ctx.role)}
      />
      <SendPauseSection pause={pause} canManage={isOwnerOrAdmin(ctx.role)} />
    </>
  );
}
