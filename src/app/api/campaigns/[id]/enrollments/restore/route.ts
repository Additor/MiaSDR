import { z } from "zod";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { restoreCampaignEnrollments } from "@/contexts/outreach/application/enrollment-restore";
import { enrollmentRestore } from "@/composition/inbox-filing";
import { withActor } from "@/app/_lib/api";

/** Email campaigns: puts removed leads back with the same rules as LinkedIn, plus the suppression list. */
export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/enrollments/restore">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict().parse(await request.json());
    return restoreCampaignEnrollments(enrollmentRestore(), actor, "email", id, ids);
  });
}
