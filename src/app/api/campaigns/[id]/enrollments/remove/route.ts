import { z } from "zod";
import { removeLeads } from "@/contexts/outreach/application/campaign-management";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/shared/api";

/** Removes the named enrollments of this campaign. Answers how many changed, were already removed, or were not found. */
export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/enrollments/remove">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict().parse(await request.json());
    return removeLeads(campaignDeps(), actor, id, ids);
  });
}
