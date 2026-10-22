import { z } from "zod";
import { previewEnrichment } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/app/_lib/api";

const body = z.object({
  steps: z.array(z.object({ providerKey: z.string().min(1).max(60), actionKey: z.string().min(1).max(60) })).max(8),
  inputs: z.record(z.string().min(1).max(60), z.string().min(1).max(60)),
});

/** What a new enrichment column would match and cost, before the enrichment dialog adds it. Reads only. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/enrichments/preview">) => {
  const { tableId } = await params;
  return withActor(async (actor) => previewEnrichment(gridRunDeps(), actor, tableId, body.parse(await request.json())));
};
