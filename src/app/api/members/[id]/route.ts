import { z } from "zod";
import { changeMemberRole, removeMember } from "@/contexts/tenancy/application/member-management";
import { memberDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { withActor, withAdmin } from "@/shared/api";

export const PATCH = async (request: Request, { params }: RouteContext<"/api/members/[id]">) => {
  const { id } = await params;
  return withAdmin("Only an owner or admin can manage members.", async (actor) => {
    const { role } = z.object({ role: z.string() }).parse(await request.json());
    await changeMemberRole(memberDeps(), actor, id, role);
    return { ok: true };
  });
};

export const DELETE = async (_request: Request, { params }: RouteContext<"/api/members/[id]">) => {
  const { id } = await params;
  return withActor((actor) => removeMember(memberDeps(), actor, id));
};
