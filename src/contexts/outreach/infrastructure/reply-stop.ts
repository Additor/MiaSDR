import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { sqlValues } from "@/platform/db/sql-values";
import { LIVE_ENROLLMENT_STATUSES } from "../domain/enrollment-status";

/**
 * A genuine reply ends the person's live enrollments on every channel and campaign. Conversations calls this inside the
 * transaction that files the message, under `lockPersonOutreachTx`, and records the event itself. Returns the rows it moved.
 */
export async function stopEnrollmentsOnReplyTx(tx: DbTx, organizationId: string, personIds: string[], now: Date): Promise<Array<{ id: string; person_id: string; channel: string }>> {
  if (personIds.length === 0) return [];
  const ids = sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `);
  return (await tx.execute(sql`
    update campaign_enrollments set status = 'replied', stop_reason = 'replied', next_send_at = null, updated_at = ${now.toISOString()}::timestamptz
    where organization_id = ${organizationId} and person_id in (${ids}) and status in ${sqlValues(LIVE_ENROLLMENT_STATUSES)}
    returning id, person_id, channel`)) as unknown as Array<{ id: string; person_id: string; channel: string }>;
}
