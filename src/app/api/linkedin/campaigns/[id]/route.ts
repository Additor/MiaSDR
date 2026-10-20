import { z } from "zod";
import { deleteLinkedInCampaign, getLinkedInCampaign, updateLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";
import { linkedinStepSchema } from "../step-schema";

export async function GET(_request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getLinkedInCampaign(linkedinCampaignDeps(), actor, id));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ name: z.string().optional(), type: z.enum(["regular", "personal"]).optional(), steps: z.array(linkedinStepSchema).optional(), senderIds: z.array(z.uuid()).max(50).optional() }).parse(await request.json());
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
