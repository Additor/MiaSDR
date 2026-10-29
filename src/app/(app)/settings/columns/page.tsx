import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { listCustomColumns } from "@/contexts/people/application/custom-columns";
import { customColumnStore } from "@/contexts/people/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { ColumnsPanel } from "./columns-panel";

export const metadata: Metadata = { title: "Custom fields" };

export default function ColumnsPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<PageSkeleton shape="form" />}>
        <Columns />
      </Suspense>
    </div>
  );
}

async function Columns() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const [people, companies] = await Promise.all([
    listCustomColumns(customColumnStore, actor, { entity: "people", includeArchived: true }),
    listCustomColumns(customColumnStore, actor, { entity: "companies", includeArchived: true }),
  ]);
  return <ColumnsPanel canManage={isOwnerOrAdmin(actor.role)} initial={JSON.parse(JSON.stringify({ people, companies }))} />;
}
