import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOnboarding } from "@/contexts/tenancy/application/onboarding";
import { onboardingDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { toActor } from "@/app/_lib/api";
import { OnboardingChecklist } from "./onboarding-checklist";

export const metadata: Metadata = { title: "Setup guide" };

export default function OnboardingPage() {
  return (
    <>
      <PageHeader title="Setup guide" />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-96 w-full max-w-2xl" />}>
          <Onboarding />
        </Suspense>
      </div>
    </>
  );
}

async function Onboarding() {
  await connection();
  const ctx = await requireOrgContext();
  const view = await getOnboarding(onboardingDeps(), toActor(ctx));
  return <OnboardingChecklist view={view} />;
}
