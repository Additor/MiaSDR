import { z } from "zod";
import { previewEnrichment } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/app/_lib/api";

const body = z.object({
  steps: z.array(z.object({ providerKey: z.string().min(1).max(60), actionKey: z.string().min(1).max(60) })).max(8),
  // Column keys run past 60 characters with a suffix or wide characters, so the cap only guards the body size.
  inputs: z.record(z.string().min(1).max(200), z.string().min(1).max(200)),
});

/** What a new enrichment column would match and cost, before the enrichment dialog adds it. Reads only. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/enrichments/preview">) => {
  const { tableId } = await params;
  return withActor(async (actor) => previewEnrichment(gridRunDeps(), actor, tableId, body.parse(await request.json())));
};
