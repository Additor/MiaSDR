import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOnboarding } from "@/contexts/tenancy/application/onboarding";
import { onboardingDeps } from "@/composition/onboarding";
import { toActor } from "@/app/_lib/api";
import { OnboardingChecklist } from "./onboarding-checklist";

export const metadata: Metadata = { title: "Setup guide" };

export default function OnboardingPage() {
  return (
    <>
      <PageHeader title="Setup guide" />
      <div className="page stack-group">
        {/* The guide is one list of steps under a progress line, with no toolbar. */}
        <Suspense fallback={<div className="max-w-2xl"><ListSkeleton toolbar={false} rows={7} /></div>}>
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
