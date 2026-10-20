import { z } from "zod";
import { removeLinkedInLead } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";
import { NotFoundError } from "@/shared/errors";

/** Removes one lead from the campaign: the enrollment becomes `removed`, the person stays. A repeat call answers `removed: false`. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/enrollments/[enrollmentId]">) {
  const { id, enrollmentId } = await ctx.params;
  return withActor((actor) => {
    if (!z.uuid().safeParse(enrollmentId).success) throw new NotFoundError("Lead not found in this campaign");
    return removeLinkedInLead(linkedinCampaignDeps(), actor, id, enrollmentId);
  });
}
