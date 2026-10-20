import { z } from "zod";
import { archiveCampaign, unarchiveCampaign } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/shared/api";

/** POST `{ archived: boolean }`. Archiving needs a completed campaign; unarchiving brings it back to the default list. */
export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/archive">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { archived } = z.object({ archived: z.boolean() }).parse(await request.json());
    await (archived ? archiveCampaign : unarchiveCampaign)(campaignDeps(), actor, id);
    return { ok: true, archived };
  });
}
