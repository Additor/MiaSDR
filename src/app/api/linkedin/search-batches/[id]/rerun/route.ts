import { z } from "zod";
import { rerunFailedSearches } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

/** Body `{ ids?: string[] }`: the failed searches to queue again, or every failed one when `ids` is missing. */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/rerun">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(1000).optional() }).parse(await request.json());
    return rerunFailedSearches(linkedinSearchBatchDeps(), actor, id, ids);
  });
}
