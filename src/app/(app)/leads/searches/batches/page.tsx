import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { listLinkedInSearchBatches } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { DEFAULT_MAX_RESULTS, MAX_SEARCH_RESULTS } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { MAX_BATCH_ROWS } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinCampaignDeps, linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { toActor } from "@/app/_lib/api";
import { UploadSheet } from "../upload-sheet";
import { BatchesPanel } from "./batches-panel";

export const metadata: Metadata = { title: "Search batches" };

export default function SearchBatchesPage() {
  return (
    <>
      <PageHeader
        title="Search batches"
        back={{ href: "/leads/searches", label: "LinkedIn searches" }}
        actions={
          <Suspense fallback={null}>
            <HeaderActions />
          </Suspense>
        }
      />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Batches />
        </Suspense>
      </div>
    </>
  );
}

/** Upload sheet. It needs the campaigns a batch can fill and the accounts it can use. */
async function HeaderActions() {
  await connection();
  const actor = toActor(await requireOrgContext());
  const [campaigns, accounts] = await Promise.all([listLinkedInCampaigns(linkedinCampaignDeps(), actor), linkedinSearchBatchDeps().batches.accounts(actor.organizationId)]);
  return (
    <UploadSheet
      config={{ accounts, maxRows: MAX_BATCH_ROWS, defaultMaxResults: DEFAULT_MAX_RESULTS, maxResultsLimit: MAX_SEARCH_RESULTS }}
      campaigns={campaigns.filter(acceptsEnrollments).map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}

async function Batches() {
  await connection();
  const actor = toActor(await requireOrgContext());
  const state = await listLinkedInSearchBatches(linkedinSearchBatchDeps(), actor);
  // Dates cross to the client as ISO strings.
  return <BatchesPanel state={JSON.parse(JSON.stringify(state))} />;
}
