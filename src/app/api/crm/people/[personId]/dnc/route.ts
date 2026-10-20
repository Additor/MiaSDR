import { z } from "zod";
import { setPersonDoNotContact } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

/** Setting it stops the person's pending and active campaign enrollments and retires open drafts. */
export async function POST(request: Request, ctx: RouteContext<"/api/crm/people/[personId]/dnc">) {
  const { personId } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ enabled: z.boolean(), reason: z.string().max(500).nullable().optional() }).parse(await request.json());
    return setPersonDoNotContact(crmDeps(), actor, personId, body);
  });
}
