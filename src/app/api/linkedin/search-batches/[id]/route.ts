import { deleteSearchBatch, getLinkedInSearchBatch } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/shared/api";

export async function GET(_request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getLinkedInSearchBatch(linkedinSearchBatchDeps(), actor, id));
}

/** Deletes the batch, its searches and the people they staged. Leads already in Leads and their enrollments stay. Answers 409 while a search runs. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => deleteSearchBatch(linkedinSearchBatchDeps(), actor, id));
}
