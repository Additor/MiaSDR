import { z } from "zod";
import { createEnrichmentColumns, createWaterfallColumns, updateRunnableColumn } from "@/contexts/grid/application/enrichment-columns";
import { gridColumnDeps } from "@/contexts/grid/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

const placement = { afterColumnId: z.string().uuid().optional(), autoRun: z.boolean().optional(), delaySeconds: z.number().int().min(0).max(3600).optional() };

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enrichment"), providerKey: z.string(), actionKey: z.string(), inputs: z.record(z.string(), z.string()), selectedOutputs: z.array(z.string()), ...placement }),
  z.object({
    kind: z.literal("waterfall"),
    name: z.string().optional(),
    inputs: z.record(z.string(), z.string()),
    steps: z.array(z.object({ providerKey: z.string(), actionKey: z.string() })),
    selectedOutputs: z.array(z.string()),
    maxCostCents: z.number().min(0).optional(),
    ...placement,
  }),
]);

/** Adds an enrichment or waterfall column with one output column per selected output. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/enrichments">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const parsed = body.parse(await request.json());
    const columns = parsed.kind === "enrichment" ? await createEnrichmentColumns(gridColumnDeps(), actor, tableId, parsed) : await createWaterfallColumns(gridColumnDeps(), actor, tableId, parsed);
    return { columns, primaryColumnKey: columns[0]?.key };
  }, 201);
};

const patch = z.object({ columnId: z.string().uuid(), inputs: z.record(z.string(), z.string()).optional(), autoRun: z.boolean().optional(), delaySeconds: z.number().int().min(0).max(3600).optional(), steps: z.array(z.object({ providerKey: z.string(), actionKey: z.string() })).min(1).max(8).optional() });

export const PATCH = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/enrichments">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const { columnId, ...rest } = patch.parse(await request.json());
    return { column: await updateRunnableColumn(gridColumnDeps(), actor, tableId, columnId, rest) };
  });
};
