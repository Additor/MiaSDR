import { z } from "zod";
import { deleteSearchBatchResults } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { MAX_BATCH_IDS } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

/**
 * Body `{ ids: string[] }` deletes the staged results found by those searches. Body `{ all: true }` deletes them for every search
 * of the batch. A missing, empty or malformed body answers 400 and deletes nothing: the call never defaults to "everything".
 * The searches stay. Leads already created stay. Answers 409 while one of the searches runs.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/leads">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z
      .union([z.object({ ids: z.array(z.string()).min(1).max(MAX_BATCH_IDS) }).strict(), z.object({ all: z.literal(true) }).strict()])
      .parse(await request.json());
    return deleteSearchBatchResults(linkedinSearchBatchDeps(), actor, id, "ids" in body ? body.ids : undefined);
  });
}
