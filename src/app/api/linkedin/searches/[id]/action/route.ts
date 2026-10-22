import { z } from "zod";
import { changeLinkedInSearch } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/searches/[id]/action">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { action } = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).parse(await request.json());
    return changeLinkedInSearch(linkedinSearchDeps(), actor, id, action);
  });
}
