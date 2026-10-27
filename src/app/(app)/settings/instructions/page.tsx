import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { AdminNotice } from "../admin-notice";
import { InstructionsPanel } from "./instructions-panel";

export const metadata: Metadata = { title: "AI instructions" };

export default function InstructionsPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
        <Instructions />
      </Suspense>
    </div>
  );
}

async function Instructions() {
  await connection();
  const ctx = await requireOrgContext();
  const canManage = isOwnerOrAdmin(ctx.role);
  const { settings } = await getReplyTypeCatalog(replyHandlingDeps(), toActor(ctx));
  return (
    <>
      {!canManage && (
        <div className="pb-section">
          <AdminNotice action="change AI instructions" />
        </div>
      )}
      <InstructionsPanel draft={settings.draftInstructions} classification={settings.classificationInstructions} canManage={canManage} />
    </>
  );
}
