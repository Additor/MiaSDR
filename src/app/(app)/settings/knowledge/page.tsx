import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { listKnowledge } from "@/contexts/conversations/ai/application/knowledge";
import { knowledgeStore } from "@/contexts/conversations/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { KnowledgePanel } from "./knowledge-panel";

export const metadata: Metadata = { title: "Knowledge" };

export default function KnowledgePage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <Knowledge />
      </Suspense>
    </div>
  );
}

async function Knowledge() {
  await connection();
  const ctx = await requireOrgContext();
  const docs = await listKnowledge(knowledgeStore, toActor(ctx));
  return <KnowledgePanel docs={JSON.parse(JSON.stringify(docs))} canManage={isOwnerOrAdmin(ctx.role)} />;
}
