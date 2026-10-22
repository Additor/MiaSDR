import { z } from "zod";
import { inviteMember } from "@/contexts/tenancy/application/member-management";
import { memberDeps } from "@/contexts/tenancy/infrastructure/member-composition";
import { withAdmin } from "@/app/_lib/api";

export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can manage members.", async (actor) => inviteMember(memberDeps(), actor, z.object({ email: z.string().max(254), role: z.string() }).parse(await request.json())), 201);
