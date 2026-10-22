import { z } from "zod";
import { resolveCampaignSend } from "@/contexts/outreach/application/send-resolution";
import { sendResolutionDeps } from "@/contexts/outreach/infrastructure/send-resolution-composition";
import { withAdmin } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/sends/[sendId]/resolve">) {
  const { id, sendId } = await ctx.params;
  return withAdmin("Only an owner or admin can settle an unconfirmed send.", async (actor) => {
    const body = z.object({ outcome: z.enum(["delivered", "not_delivered"]), checkedSentFolder: z.boolean().optional() }).parse(await request.json());
    await resolveCampaignSend(sendResolutionDeps(), actor, id, sendId, body);
    return { ok: true };
  });
}
