import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listInvitations, listMembers } from "@/contexts/tenancy/application/member-management";
import { memberDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { isOwnerOrAdmin, parseRoles } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { env } from "@/shared/env";
import { MembersPanel } from "./members-panel";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <Members />
      </Suspense>
    </div>
  );
}

async function Members() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const deps = memberDeps();
  const canManage = isOwnerOrAdmin(ctx.role);
  const [members, invitations] = await Promise.all([listMembers(deps, actor), canManage ? listInvitations(deps, actor) : Promise.resolve([])]);
  const { RESEND_API_KEY, AUTH_EMAIL_FROM, APP_URL } = env();
  return (
    <MembersPanel
      members={JSON.parse(JSON.stringify(members))}
      invitations={JSON.parse(JSON.stringify(invitations))}
      currentUserId={ctx.user.id}
      actorIsOwner={parseRoles(ctx.role).includes("owner")}
      canManage={canManage}
      emailConfigured={Boolean(RESEND_API_KEY && AUTH_EMAIL_FROM)}
      appUrl={APP_URL}
    />
  );
}
