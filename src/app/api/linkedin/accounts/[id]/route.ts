import { z } from "zod";
import { updateLinkedInAccount } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withAdmin } from "@/shared/api";

const window = z.object({ start: z.string(), end: z.string() });
const settings = z.object({
  dailyInviteLimit: z.number().optional(),
  dailyMessageLimit: z.number().optional(),
  isPremium: z.boolean().optional(),
  workingHours: z.object({ timeZone: z.string(), days: z.record(z.string(), z.array(window)) }).nullable().optional(),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/linkedin/accounts/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can manage LinkedIn.", async (actor) => {
    const { warnings } = await updateLinkedInAccount(linkedinManagementDeps(), actor, id, settings.parse(await request.json()));
    return { ok: true, warnings };
  });
}
