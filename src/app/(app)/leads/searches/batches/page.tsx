import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { listLinkedInSearchBatches } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { linkedinCampaignDeps, linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { toActor } from "@/shared/api";
import { BatchesPanel } from "./batches-panel";

export const metadata: Metadata = { title: "Search batches" };

export default function SearchBatchesPage() {
  return (
    <>
      <PageHeader title="Search batches" back={{ href: "/leads/searches", label: "LinkedIn searches" }} />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Batches />
        </Suspense>
      </div>
    </>
  );
}

async function Batches() {
  await connection();
  const actor = toActor(await requireOrgContext());
  const [state, campaigns] = await Promise.all([listLinkedInSearchBatches(linkedinSearchBatchDeps(), actor), listLinkedInCampaigns(linkedinCampaignDeps(), actor)]);
  return (
    <BatchesPanel
      state={JSON.parse(JSON.stringify(state))}
      campaigns={campaigns.filter(acceptsEnrollments).map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
