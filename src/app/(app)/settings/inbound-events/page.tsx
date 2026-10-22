import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listInboundEvents, type InboundStateFilter } from "@/contexts/outreach/application/inbound-review";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { InboundEventsPanel } from "./inbound-events-panel";
import { AdminNotice } from "../admin-notice";

export const metadata: Metadata = { title: "Inbound events" };

const PAGE_SIZE = 25;
const STATES: InboundStateFilter[] = ["open", "dead", "retrying", "queued", "dismissed", "all"];
const SOURCES = ["all", "gmail", "linkedin"] as const;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default function InboundEventsPage({ searchParams }: PageProps<"/settings/inbound-events">) {
  return (
    <div className="max-w-5xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-5xl" />}>
        <InboundEvents searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function InboundEvents({ searchParams }: { searchParams: PageProps<"/settings/inbound-events">["searchParams"] }) {
  await connection();
  const ctx = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.role)) return <AdminNotice action="review inbound events" replacesPage />;
  const params = await searchParams;
  const state = STATES.find((s) => s === first(params.state)) ?? "open";
  const source = SOURCES.find((s) => s === first(params.source)) ?? "all";
  const page = Math.max(Number(first(params.page)) || 1, 1);
  const result = await listInboundEvents(inboundReviewDeps(), toActor(ctx), { state, source, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return <InboundEventsPanel rows={JSON.parse(JSON.stringify(result.rows))} total={result.total} page={page} pageSize={PAGE_SIZE} state={state} source={source} />;
}
