import { z } from "zod";
import { cellRuns } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withActor } from "@/shared/api";

/** Run ledger of one cell: provider, outcome, cost and latency per attempt, newest first. */
export const GET = async (request: Request, { params }: RouteContext<"/api/grid/tables/[tableId]/cell-runs">) => {
  const { tableId } = await params;
  const url = new URL(request.url);
  return withActor((actor) => {
    const query = z.object({ rowId: z.string().uuid(), columnKey: z.string().min(1) }).parse({ rowId: url.searchParams.get("rowId"), columnKey: url.searchParams.get("columnKey") });
    return cellRuns(gridRunDeps(), actor, tableId, query.rowId, query.columnKey);
  });
};
