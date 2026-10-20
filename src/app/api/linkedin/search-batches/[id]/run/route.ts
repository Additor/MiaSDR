import { z } from "zod";
import { runSearchBatch } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { MAX_BATCH_IDS } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

/** Body `{ ids?: string[] }`: the searches to run now, or every paused and queued search of the batch. Limits and pacing still apply. */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/run">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(MAX_BATCH_IDS).optional() }).strict().parse(await request.json().catch(() => ({})));
    return runSearchBatch(linkedinSearchBatchDeps(), actor, id, ids);
  });
}
