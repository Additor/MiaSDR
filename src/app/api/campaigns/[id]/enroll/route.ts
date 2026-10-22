import { z } from "zod";
import { enrollLeads, enrollPickedLeads } from "@/contexts/outreach/application/campaign-management";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/** Either a search (`query`, `limit`; `dryRun` counts the people it would add and enrolls nobody) or the people a person picked (`personIds`), never both. */
const body = z.union([
  z.object({ personIds: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict(),
  z.object({ query: z.string().max(100).optional(), limit: z.number().int().positive().optional(), dryRun: z.boolean().optional() }).strict(),
]);

export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/enroll">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const input = body.parse(await request.json());
    return "personIds" in input ? enrollPickedLeads(campaignDeps(), actor, id, input.personIds) : enrollLeads(campaignDeps(), actor, id, input);
  });
}
