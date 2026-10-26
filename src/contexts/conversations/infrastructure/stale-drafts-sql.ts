import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { rowsOf, sqlValues } from "@/platform/db/sql-values";
import { RETIRABLE_DRAFT_STATUSES } from "../domain/draft-status";

/**
 * Drafts nobody has acted on turn `stale` with `reason`: a new inbound message, a stage move or a correction made the
 * text outdated. A draft that is sending or already sent stays as it is. Returns how many changed.
 */
export async function staleOpenDraftsTx(tx: DbTx, input: { organizationId: string; recordId: string; reason: string; now: Date }): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update drafts set status = 'stale', error = ${input.reason}, updated_at = ${input.now.toISOString()}::timestamptz
      where organization_id = ${input.organizationId} and record_id = ${input.recordId} and status in ${sqlValues(RETIRABLE_DRAFT_STATUSES)}
      returning id`),
  );
  return rows.length;
}
