import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { listDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";
import { StagesPanel } from "./stages-panel";

export const metadata: Metadata = { title: "Pipeline stages" };

export default function PipelineStagesPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-80 w-full max-w-3xl" data-testid="stages-loading" />}>
        <Stages />
      </Suspense>
    </div>
  );
}

async function Stages() {
  await connection();
  const settings = await listDealStages(dealsDeps(), toActor(await requireOrgContext()));
  return <StagesPanel settings={settings} />;
}
