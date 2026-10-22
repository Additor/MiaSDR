import { z } from "zod";
import { removeLead } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { NotFoundError } from "@/shared/errors";

/** Removes one lead from the campaign: the enrollment becomes `removed`, the person stays. A repeat call answers `removed: false`. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/campaigns/[id]/enrollments/[enrollmentId]">) {
  const { id, enrollmentId } = await ctx.params;
  return withActor((actor) => {
    if (!z.uuid().safeParse(enrollmentId).success) throw new NotFoundError("Lead not found in this campaign");
    return removeLead(campaignDeps(), actor, id, enrollmentId);
  });
}
