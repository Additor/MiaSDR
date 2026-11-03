import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { rowsOf } from "@/platform/db/sql-values";
import type { AgentVia } from "@/shared/errors";
import { detectsStopRequest } from "../domain/stop-request";
import { pickAsksToStopSql } from "./stop-requested-sql";

/**
 * The one writer of `stop_reviews` (`src/architecture/stop-review-writer.test.ts`). A person's decision about a record or a
 * reply answers the stop requests it covers: a type change, a pick, Looks right, undo, do not contact. An agent's call
 * records nothing, so no sequence of tool calls opens the agent send gate. With `messageId` it covers that reply, otherwise
 * every reply of the record a pick reads as a stop request and the latest reply whose own words ask.
 */
export async function personReviewedStopsTx(
  tx: DbTx,
  input: { organizationId: string; recordId: string; messageId?: string; actorUserId: string; via?: AgentVia; now: Date },
): Promise<void> {
  if (input.via) return;
  const { organizationId, recordId, actorUserId, now } = input;
  const scope = input.messageId ? sql`and k.message_id = ${input.messageId}::uuid` : sql``;
  await tx.execute(sql`
    insert into stop_reviews (organization_id, message_id, reviewed_by, reviewed_at)
    select distinct k.organization_id, k.message_id, ${actorUserId}::uuid, ${now.toISOString()}::timestamptz
    from reply_type_picks k
    where k.organization_id = ${organizationId} and k.record_id = ${recordId} ${scope} and ${pickAsksToStopSql("k")}
    on conflict (message_id) do nothing`);
  const [reply] = rowsOf<{ id: string; body: string | null }>(
    await tx.execute(sql`
      select m.id, m.body_text as body from messages m
      where m.organization_id = ${organizationId}
        and m.id = ${input.messageId ? sql`${input.messageId}::uuid` : sql`(select r.latest_inbound_message_id from records r where r.id = ${recordId} and r.organization_id = ${organizationId})`}`),
  );
  if (!reply || !detectsStopRequest(reply.body ?? "")) return;
  await tx.execute(sql`
    insert into stop_reviews (organization_id, message_id, reviewed_by, reviewed_at)
    values (${organizationId}, ${reply.id}::uuid, ${actorUserId}::uuid, ${now.toISOString()}::timestamptz)
    on conflict (message_id) do nothing`);
}
