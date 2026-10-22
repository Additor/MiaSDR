import { getLinkedInSearch } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

export async function GET(_request: Request, ctx: RouteContext<"/api/linkedin/searches/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getLinkedInSearch(linkedinSearchDeps(), actor, id));
}
