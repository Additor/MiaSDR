import { z } from "zod";
import { retryFailedCells } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

/** Re-queues failed cells only. */
export const POST = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/run/retry">) => {
  const { tableId } = await params;
  return withActor(async (actor) => {
    const text = await request.text();
    const { columnKey } = z.object({ columnKey: z.string().min(1).optional() }).parse(text.trim() ? JSON.parse(text) : {});
    return retryFailedCells(gridRunDeps(), actor, tableId, columnKey);
  });
};
