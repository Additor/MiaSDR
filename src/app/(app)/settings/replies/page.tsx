import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { AdminNotice } from "../admin-notice";
import { ConfidenceFloorForm } from "./confidence-floor-form";
import { ReplyTypesPanel } from "./reply-types-panel";
import { UnknownSenderLimitForm } from "./unknown-sender-limit-form";

export const metadata: Metadata = { title: "Reply handling" };

export default function ReplySettingsPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
        <Settings />
      </Suspense>
    </div>
  );
}

async function Settings() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const canManage = isOwnerOrAdmin(ctx.role);
  const [{ replyTypes, settings }, org] = await Promise.all([getReplyTypeCatalog(replyHandlingDeps(), actor), getOrganization(organizationDeps(), actor)]);
  return (
    <>
      {!canManage && (
        <div className="pb-section">
          <AdminNotice action="change reply settings" />
        </div>
      )}
      {/* The list of reply types leads the page; the two organization-wide limits follow it. */}
      <ReplyTypesPanel replyTypes={replyTypes} canManage={canManage} />
      <ConfidenceFloorForm confidenceFloor={settings.autoApplyConfidence} canManage={canManage} />
      <UnknownSenderLimitForm limit={org.unknownSenderAiDailyCap} timeZone={org.timeZone} canManage={canManage} />
    </>
  );
}
