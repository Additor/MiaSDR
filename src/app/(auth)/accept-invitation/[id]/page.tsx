import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthCardSkeleton } from "../../auth-skeleton";
import { auth } from "@/contexts/identity/infrastructure/auth";
import { getInvitationView } from "@/contexts/tenancy/application/invitation-view";
import { invitationViewDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { AcceptInvitation } from "./accept-invitation";

export const metadata: Metadata = { title: "Accept invitation" };

export default function AcceptInvitationPage({ params }: PageProps<"/accept-invitation/[id]">) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <Invitation params={params} />
    </Suspense>
  );
}

async function Invitation({ params }: { params: PageProps<"/accept-invitation/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const session = await auth().api.getSession({ headers: await headers() });
  const view = await getInvitationView(invitationViewDeps(), { invitationId: id, viewerEmail: session?.user.email ?? null });
  return <AcceptInvitation invitationId={id} view={view} />;
}
