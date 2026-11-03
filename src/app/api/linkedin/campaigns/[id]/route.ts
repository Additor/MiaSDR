import { z } from "zod";
import { MAX_CAMPAIGN_SENDERS } from "@/contexts/outreach/application/enrollment-admin";
import { deleteLinkedInCampaign, updateLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";
import { linkedinStepSchema } from "@/contexts/outreach/linkedin/domain/step-schema";

export async function PATCH(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ name: z.string().optional(), steps: z.array(linkedinStepSchema).optional(), senderIds: z.array(z.uuid()).max(MAX_CAMPAIGN_SENDERS).optional() }).parse(await request.json());
    await updateLinkedInCampaign(linkedinCampaignDeps(), actor, id, body);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteLinkedInCampaign(linkedinCampaignDeps(), actor, id);
    return { ok: true };
  });
}
