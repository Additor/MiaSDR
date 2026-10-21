import { z } from "zod";
import { cancelRun, requestRun, runStatus } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

const body = z.object({
  columnKey: z.string().min(1).optional(),
  rowIds: z.array(z.string().uuid()).optional(),
  onlyEmpty: z.boolean().optional(),
  maxRows: z.number().int().optional(),
  firstN: z.number().int().optional(),
  maxCostCents: z.number().optional(),
  fresh: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

/** Job counts for the toolbar. */
export const GET = async (_request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/run">) => {
  const { tableId } = await params;
  return withActor((actor) => runStatus(gridRunDeps(), actor, tableId));
};

/** Queues the runnable columns. An empty body runs everything; a malformed body is an error, never "everything". */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/run">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const text = await request.text();
    return requestRun(gridRunDeps(), actor, tableId, text.trim() ? body.parse(JSON.parse(text)) : {});
  });
};

/** Stop: removes queued cells. A cell that is mid-call finishes. */
export const DELETE = async (_request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/run">) => {
  const { tableId } = await params;
  return withActor((actor) => cancelRun(gridRunDeps(), actor, tableId));
};
