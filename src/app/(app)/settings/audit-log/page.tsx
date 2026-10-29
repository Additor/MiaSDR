import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { AUDIT_AREAS, listAuditLog } from "@/contexts/tenancy/application/audit-log";
import { auditLogStore } from "@/contexts/tenancy/infrastructure/organization-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { AdminNotice } from "../admin-notice";
import { AuditLogPanel } from "./audit-log-panel";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default function AuditLogPage({ searchParams }: PageProps<"/settings/audit-log">) {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="table" />}>
        <AuditLog searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function AuditLog({ searchParams }: { searchParams: PageProps<"/settings/audit-log">["searchParams"] }) {
  await connection();
  const ctx = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.role)) return <AdminNotice action="read the audit log" replacesPage />;
  const params = await searchParams;
  const area = AUDIT_AREAS.find((a) => a === first(params.area)) ?? "all";
  const page = Math.max(Number(first(params.page)) || 1, 1);
  const result = await listAuditLog(auditLogStore, toActor(ctx), { area: area === "all" ? null : area, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return <AuditLogPanel rows={JSON.parse(JSON.stringify(result.rows))} total={result.total} page={page} pageSize={PAGE_SIZE} area={area} />;
}
