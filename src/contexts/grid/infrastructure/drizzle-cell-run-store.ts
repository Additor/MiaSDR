import { and, desc, eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { gridCellRuns } from "@/platform/db/schema";
import type { CellRunStore } from "../application/ports";

export const drizzleCellRunStore: CellRunStore = {
  async latestRun(organizationId, tableId, rowId, sourceColumnKey) {
    const [run] = await db
      .select({
        id: gridCellRuns.id,
        provider: gridCellRuns.provider,
        outcome: gridCellRuns.outcome,
        costCents: gridCellRuns.costCents,
        latencyMs: gridCellRuns.latencyMs,
        request: gridCellRuns.request,
        response: gridCellRuns.response,
        createdAt: gridCellRuns.createdAt,
      })
      .from(gridCellRuns)
      .where(and(eq(gridCellRuns.organizationId, organizationId), eq(gridCellRuns.tableId, tableId), eq(gridCellRuns.rowId, rowId), eq(gridCellRuns.columnKey, sourceColumnKey)))
      .orderBy(desc(gridCellRuns.createdAt))
      .limit(1);
    return run ? { ...run, costCents: Number(run.costCents ?? 0) } : null;
  },
};
