import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getLinkedInSearchBatch } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { getSearchCapacity } from "@/contexts/outreach/linkedin/application/linkedin-search-capacity";
import { canManageBatch } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinSearchBatchDeps, linkedinSearchCapacityDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";
import { BatchDetail } from "./batch-detail";

export const metadata: Metadata = { title: "Search batch" };

export default function SearchBatchPage({ params }: PageProps<"/leads/searches/batches/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <Batch params={params} />
    </Suspense>
  );
}

async function Batch({ params }: { params: PageProps<"/leads/searches/batches/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const actor = toActor(await requireOrgContext());
  const batch = await getLinkedInSearchBatch(linkedinSearchBatchDeps(), actor, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const capacity = await getSearchCapacity(linkedinSearchCapacityDeps(), actor, batch.accountIds);
  const canManage = canManageBatch({ isOwnerOrAdmin: isOwnerOrAdmin(actor.role), actorUserId: actor.userId, createdBy: batch.createdBy });
  return (
    <>
      <PageHeader title={batch.name} back={{ href: "/leads/searches/batches", label: "Search batches" }} />
      <div className="page stack-group">
        {batch.sourceFilename && <p className="text-sm text-muted-foreground">From {batch.sourceFilename}</p>}
        <BatchDetail batch={JSON.parse(JSON.stringify(batch))} capacity={JSON.parse(JSON.stringify(capacity))} canManage={canManage} />
      </div>
    </>
  );
}
