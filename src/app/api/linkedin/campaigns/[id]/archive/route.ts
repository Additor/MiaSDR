import { z } from "zod";
import { archiveLinkedInCampaign, unarchiveLinkedInCampaign } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

/** POST `{ archived: boolean }`. Archiving needs a completed campaign; unarchiving brings it back to the default list. */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/archive">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { archived } = z.object({ archived: z.boolean() }).parse(await request.json());
    await (archived ? archiveLinkedInCampaign : unarchiveLinkedInCampaign)(linkedinCampaignDeps(), actor, id);
    return { ok: true, archived };
  });
}
