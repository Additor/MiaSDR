import { z } from "zod";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { restoreCampaignEnrollments } from "@/contexts/outreach/application/enrollment-restore";
import { enrollmentRestoreDeps } from "@/contexts/outreach/infrastructure/restore-composition";
import { withActor } from "@/shared/api";

/**
 * Puts removed leads back: `pending` when nothing was sent, `active` when the lead has progress. Leads that replied, are on do not contact,
 * are active in another LinkedIn campaign, or sit in a closed campaign stay removed; `refused` says why for each.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/enrollments/restore">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict().parse(await request.json());
    return restoreCampaignEnrollments(enrollmentRestoreDeps(), actor, "linkedin", id, ids);
  });
}
