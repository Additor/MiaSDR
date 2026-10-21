import { z } from "zod";
import { createAiColumns, updateRunnableColumn } from "@/contexts/grid/enrichment/application/enrichment-columns";
import { AI_OUTPUT_TYPES } from "@/contexts/grid/enrichment/domain/enrichment-config";
import { gridColumnDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

const output = z.object({ key: z.string(), type: z.enum(AI_OUTPUT_TYPES), description: z.string().max(300).optional() });

const post = z.object({
  name: z.string().optional(),
  prompt: z.string().min(1).max(8000),
  outputs: z.array(output).min(1).max(12),
  afterColumnId: z.string().uuid().optional(),
  autoRun: z.boolean().optional(),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
});

/** Adds an AI column with one output column per field. Runs with the organization's own AI key. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/ai">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const columns = await createAiColumns(gridColumnDeps(), actor, tableId, post.parse(await request.json()));
    return { columns, primaryColumnKey: columns[0]?.key };
  }, 201);
};

const patch = z.object({
  columnId: z.string().uuid(),
  prompt: z.string().min(1).max(8000).optional(),
  autoRun: z.boolean().optional(),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
  /** The full list of output fields. Fields that match a column by key, then by name, keep it. */
  outputs: z.array(output).min(1).max(12).optional(),
});

export const PATCH = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/ai">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const { columnId, ...rest } = patch.parse(await request.json());
    return { column: await updateRunnableColumn(gridColumnDeps(), actor, tableId, columnId, rest) };
  });
};
