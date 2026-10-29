import { exportSearchBatchResults } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { linkedinSearchBatchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

/** Streams the batch's stored results as CSV: UTF-8 with BOM, formula-safe cells, pages of 1,000 rows. */
export async function GET(_request: Request, ctx: RouteContext<"/api/linkedin/search-batches/[id]/results">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const chunks = exportSearchBatchResults(linkedinSearchBatchDeps(), actor, id);
    // The first chunk checks the batch exists in this organization, so a wrong id answers 404 before any stream starts.
    const first = await chunks.next();
    const encoder = new TextEncoder();
    let sentFirst = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = sentFirst ? await chunks.next() : first;
          sentFirst = true;
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="search-batch-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
