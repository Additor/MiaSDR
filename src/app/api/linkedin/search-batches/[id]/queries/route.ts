import { z } from "zod";
import { addSearchBatchUrls, removeSearchBatchUrls } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { MAX_BATCH_IDS, MAX_BATCH_ROWS } from "@/contexts/outreach/linkedin/domain/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

/** Body `{ urls: string[] }`: LinkedIn people search addresses to add to the batch. Answers how many queued and why others did not. */
export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/queries">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { urls } = z.object({ urls: z.array(z.string().max(4000)).min(1).max(MAX_BATCH_ROWS) }).strict().parse(await request.json());
    return addSearchBatchUrls(linkedinSearchBatchDeps(), actor, id, urls);
  }, 201);
}

/**
 * Body `{ ids: string[] }`: deletes those searches and the people they staged. Leads already in Leads and their enrollments stay.
 * Answers 409 "This search is still running" and deletes nothing while one of them runs.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/queries">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(MAX_BATCH_IDS) }).strict().parse(await request.json());
    return removeSearchBatchUrls(linkedinSearchBatchDeps(), actor, id, ids);
  });
}
