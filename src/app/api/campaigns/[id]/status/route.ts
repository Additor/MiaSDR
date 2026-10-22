import { z } from "zod";
import { changeCampaignStatus } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/status">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { status } = z.object({ status: z.enum(["active", "paused", "completed"]) }).parse(await request.json());
    const { emptySubjectLeads, sampled } = await changeCampaignStatus(campaignDeps(), actor, id, status);
    return { ok: true, status, emptySubjectLeads, sampled };
  });
}
