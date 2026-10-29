import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listSuppressions } from "@/contexts/outreach/application/suppression-list";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { suppressions } from "@/composition/inbox-filing";
import { toActor } from "@/app/_lib/api";
import { SuppressionPanel } from "./suppression-panel";

export const metadata: Metadata = { title: "Suppression list" };

const PAGE_SIZE = 25;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default function SuppressionPage({ searchParams }: PageProps<"/settings/suppression">) {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Suppression searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Suppression({ searchParams }: { searchParams: PageProps<"/settings/suppression">["searchParams"] }) {
  await connection();
  const ctx = await requireOrgContext();
  const params = await searchParams;
  const q = (first(params.q) ?? "").trim().slice(0, 320);
  const page = Math.max(Number(first(params.page)) || 1, 1);
  const result = await listSuppressions(suppressions(), toActor(ctx), { q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return <SuppressionPanel rows={JSON.parse(JSON.stringify(result.rows))} total={result.total} page={page} pageSize={PAGE_SIZE} q={q} canManage={isOwnerOrAdmin(ctx.role)} />;
}
