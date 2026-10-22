import { z } from "zod";
import { removeLinkedInLeads } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

/** Removes the named enrollments of this campaign. Answers how many changed, were already removed, or were not found. */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/enrollments/remove">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict().parse(await request.json());
    return removeLinkedInLeads(linkedinCampaignDeps(), actor, id, ids);
  });
}
