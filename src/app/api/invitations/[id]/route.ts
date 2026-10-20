import { headers } from "next/headers";
import { NextResponse, connection } from "next/server";
import { auth } from "@/contexts/identity/infrastructure/auth";
import { revokeInvitation } from "@/contexts/tenancy/application/member-management";
import { getInvitationView } from "@/contexts/tenancy/application/invitation-view";
import { memberDeps, invitationViewDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { withActor } from "@/shared/api";

/**
 * The accept-invitation page's data. It needs a session but no organization: the invited person usually has none yet.
 * The view depends on who asks: only the invited address sees role, inviter and expiry.
 */
export const GET = async (_request: Request, { params }: RouteContext<"/api/invitations/[id]">) => {
  await connection();
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const view = await getInvitationView(invitationViewDeps(), { invitationId: id, viewerEmail: session.user.email });
  return NextResponse.json(view, { status: view.state === "not-found" ? 404 : 200 });
};

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/invitations/[id]">) => {
  const { id } = await params;
  return withActor((actor) => revokeInvitation(memberDeps(), actor, id));
};
