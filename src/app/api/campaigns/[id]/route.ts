import { z } from "zod";
import { deleteCampaign, updateCampaign } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { stepSchema } from "../step-schema";

export async function PATCH(request: Request, ctx: RouteContext<"/api/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ name: z.string().optional(), steps: z.array(stepSchema).optional(), senderIds: z.array(z.uuid()).max(50).optional() }).parse(await request.json());
    await updateCampaign(campaignDeps(), actor, id, body);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/campaigns/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteCampaign(campaignDeps(), actor, id);
    return { ok: true };
  });
}
