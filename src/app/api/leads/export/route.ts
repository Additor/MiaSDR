import { exportLeadsCsv } from "@/contexts/people/application/lead-management";
import { parseLeadFilter } from "@/contexts/people/domain/lead-filter";
import { leadDeps } from "@/contexts/people/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/** Streams the leads matching the list filter params (`q`, `campaign`, `email`, `ids` and the rest, see `parseLeadFilter`) as CSV: UTF-8 with BOM, formula-safe cells, batches of 1,000 rows. */
export const GET = (request: Request) =>
  withActor(async (actor) => {
    const params = new URL(request.url).searchParams;
    const filter = parseLeadFilter((key) => params.get(key));

    const chunks = exportLeadsCsv(leadDeps(), actor, filter);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next();
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

    const date = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="leads-${date}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
