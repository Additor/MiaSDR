import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { isOwnerOrAdmin, parseRoles } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { timeZoneOptions } from "../time-zone-options";
import { OrganizationForm } from "./organization-form";

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
  const org = await getOrganization(organizationDeps(), toActor(ctx));
  const zones = timeZoneOptions(Intl.supportedValuesOf("timeZone"), org.timeZone);
  return (
    <OrganizationForm
      org={{ name: org.name, slug: org.slug, timeZone: org.timeZone, unknownSenderAiDailyCap: org.unknownSenderAiDailyCap, defaultPhoneCountry: org.defaultPhoneCountry }}
      zones={zones}
      canRename={parseRoles(ctx.role).includes("owner")}
      canEditZone={isOwnerOrAdmin(ctx.role)}
    />
  );
}
