import { NextResponse, connection } from "next/server";
import { exportLeadsCsv } from "@/contexts/leads/application/lead-management";
import { parseLeadFilter } from "@/contexts/leads/domain/lead-filter";
import { leadDeps } from "@/contexts/leads/infrastructure/composition";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/app/_lib/api";

/** Streams the leads matching the list filter params (`q`, `campaign`, `email`, `ids` and the rest, see `parseLeadFilter`) as CSV: UTF-8 with BOM, formula-safe cells, batches of 1,000 rows. */
export async function GET(request: Request) {
  // Reads the session and the database, so it must not be prerendered at build time.
  await connection();
  const ctx = await apiOrgContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const filter = parseLeadFilter((key) => params.get(key));

  const chunks = exportLeadsCsv(leadDeps(), toActor(ctx), filter);
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
}
