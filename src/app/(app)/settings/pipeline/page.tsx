import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { listDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { StagesPanel } from "./stages-panel";

export const metadata: Metadata = { title: "Pipeline stages" };

export default function PipelineStagesPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Stages />
      </Suspense>
    </div>
  );
}

async function Stages() {
  await connection();
  const ctx = await requireOrgContext();
  const settings = await listDealStages(dealsDeps(), toActor(ctx));
  return <StagesPanel settings={settings} canManage={isOwnerOrAdmin(ctx.role)} />;
}
