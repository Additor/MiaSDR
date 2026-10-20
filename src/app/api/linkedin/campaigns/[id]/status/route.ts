import { z } from "zod";
import { changeLinkedInCampaignStatus } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/status">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { status } = z.object({ status: z.enum(["active", "paused", "completed"]) }).parse(await request.json());
    await changeLinkedInCampaignStatus(linkedinCampaignDeps(), actor, id, status);
    return { ok: true, status };
  });
}
