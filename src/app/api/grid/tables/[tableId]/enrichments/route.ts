import { z } from "zod";
import { createEnrichmentColumns, createWaterfallColumns, fillAddedOutput, updateRunnableColumn } from "@/contexts/grid/enrichment/application/enrichment-columns";
import { gridColumnDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/app/_lib/api";

const placement = { afterColumnId: z.string().uuid().optional(), autoRun: z.boolean().optional(), delaySeconds: z.number().int().min(0).max(3600).optional(), reuseDays: z.number().int().min(0).max(365).optional(),
  settledStatuses: z.array(z.enum(["valid", "invalid", "catch_all", "unknown", "disposable"])).min(1).max(5).optional(),
};

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enrichment"), name: z.string().max(200).optional(), providerKey: z.string(), actionKey: z.string(), inputs: z.record(z.string(), z.string()), selectedOutputs: z.array(z.string()), ...placement }),
  z.object({
    kind: z.literal("waterfall"),
    name: z.string().optional(),
    inputs: z.record(z.string(), z.string()),
    steps: z.array(z.object({ providerKey: z.string(), actionKey: z.string() })),
    selectedOutputs: z.array(z.string()),
    maxCostCents: z.number().min(0).optional(),
    maxCredits: z.number().min(0).optional(),
    onRateLimit: z.enum(["next", "wait"]).optional(),
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

// Strict: a field this route does not change is refused, never dropped with a 200.
const patch = z.strictObject({
  columnId: z.string().uuid(),
  inputs: z.record(z.string(), z.string()).optional(),
  autoRun: z.boolean().optional(),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
  steps: z.array(z.strictObject({ providerKey: z.string(), actionKey: z.string() })).min(1).max(8).optional(),
  maxCostCents: z.number().min(0).max(100_000).nullable().optional(),
  maxCredits: z.number().min(0).max(100_000).nullable().optional(),
  onRateLimit: z.enum(["next", "wait"]).optional(),
  reuseDays: z.number().int().min(0).max(365).optional(),
  settledStatuses: z.array(z.enum(["valid", "invalid", "catch_all", "unknown", "disposable"])).min(1).max(5).nullable().optional(),
  addOutput: z.string().min(1).max(60).optional(),
});

export const PATCH = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/enrichments">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const { columnId, ...rest } = patch.parse(await request.json());
    const column = await updateRunnableColumn(gridColumnDeps(), actor, tableId, columnId, rest);
    // A field added as a column takes the answers the column already has, so it fills without a new call.
    const added = rest.addOutput ? await fillAddedOutput(gridColumnDeps(), actor, tableId, columnId, rest.addOutput) : null;
    return { column, ...(added ? { filled: added.filled } : {}) };
  });
};
