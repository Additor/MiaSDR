import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { listLinkedInSearches } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { getSearchCapacity } from "@/contexts/outreach/linkedin/application/linkedin-search-capacity";
import { DEFAULT_MAX_RESULTS, MAX_SEARCH_RESULTS } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { MAX_BATCH_ROWS } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinCampaignDeps, linkedinSearchBatchDeps, linkedinSearchCapacityDeps, linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { toActor } from "@/shared/api";
import { SearchesPanel } from "./searches-panel";

export const metadata: Metadata = { title: "LinkedIn searches" };

export default function LinkedInSearchesPage() {
  return (
    <>
      <PageHeader title="LinkedIn searches" back={{ href: "/leads", label: "Leads" }} />
      <div className="page stack-group">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Searches />
        </Suspense>
      </div>
    </>
  );
}

async function Searches() {
  await connection();
  const actor = toActor(await requireOrgContext());
  const [state, campaigns, capacity, accounts] = await Promise.all([
    listLinkedInSearches(linkedinSearchDeps(), actor),
    listLinkedInCampaigns(linkedinCampaignDeps(), actor),
    getSearchCapacity(linkedinSearchCapacityDeps(), actor),
    linkedinSearchBatchDeps().batches.accounts(actor.organizationId),
  ]);
  return (
    <SearchesPanel
      // Dates cross to the client as ISO strings.
      state={JSON.parse(JSON.stringify(state))}
      capacity={JSON.parse(JSON.stringify(capacity))}
      campaigns={campaigns.filter(acceptsEnrollments).map((c) => ({ id: c.id, name: c.name }))}
      upload={{ accounts, maxRows: MAX_BATCH_ROWS, defaultMaxResults: DEFAULT_MAX_RESULTS, maxResultsLimit: MAX_SEARCH_RESULTS }}
    />
  );
}
