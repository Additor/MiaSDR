import { z } from "zod";
import { previewAiAnswer } from "@/contexts/grid/enrichment/application/ai-preview";
import { AI_OUTPUT_TYPES } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { cellAnswerer } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { gridDeps } from "@/contexts/grid/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

const body = z.object({
  prompt: z.string().min(1).max(8000),
  outputs: z.array(z.object({ key: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), type: z.enum(AI_OUTPUT_TYPES), description: z.string().max(300).optional() })).min(1).max(12),
  rowId: z.string().uuid().optional(),
});

/** Answers an AI column's prompt for one row (the first by default) without saving anything. One paid AI call. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/ai/preview">) => {
  const { tableId } = await params;
  return withActor(async (actor) => previewAiAnswer({ ...gridDeps(), ai: cellAnswerer }, actor, tableId, body.parse(await request.json())));
};
