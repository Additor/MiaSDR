import { z } from "zod";
import { MAX_PICKED_IDS } from "@/contexts/outreach/application/enrollment-admin";
import { enrollLinkedInLeadsWithNotices, enrollPickedLinkedInLeadsWithNotices } from "@/contexts/outreach/linkedin/application/linkedin-enroll-notices";
import { linkedinNoticeDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

/** Either a search (`query`, `limit`; `dryRun` counts the people it would add and enrolls nobody) or the people a person picked (`personIds`), never both. The answer carries `notices`: people also contacted in other campaigns. */
const body = z.union([
  z.object({ personIds: z.array(z.uuid()).min(1).max(MAX_PICKED_IDS) }).strict(),
  z.object({ query: z.string().max(100).optional(), limit: z.number().int().positive().optional(), dryRun: z.boolean().optional() }).strict(),
]);

export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/enroll">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const input = body.parse(await request.json());
    return "personIds" in input ? enrollPickedLinkedInLeadsWithNotices(linkedinNoticeDeps(), actor, id, input.personIds) : enrollLinkedInLeadsWithNotices(linkedinNoticeDeps(), actor, id, input);
  });
}
