import { revokeInvitation } from "@/contexts/tenancy/application/member-management";
import { memberDeps } from "@/composition/members";
import { withActor } from "@/app/_lib/api";

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/invitations/[id]">) => {
  const { id } = await params;
  return withActor((actor) => revokeInvitation(memberDeps(), actor, id));
};
