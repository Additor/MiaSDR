import { sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import type { AgentVia } from "@/shared/errors";
import { pickAsksToStopSql, wordsAskToStopSql } from "@/platform/db/stop-review-sql";

/**
 * The one writer of `stop_reviews` (`src/architecture/stop-review-writer.test.ts`). A person's decision about a conversation or a
 * reply answers the stop requests it covers: a type change, a pick, undo, do not contact. An agent's call
 * conversations nothing, so no sequence of tool calls opens the agent send gate. With `messageId` it covers that reply, otherwise
 * every reply of the record a pick reads as a stop request and the latest reply whose own words ask.
 */
export async function personReviewedStopsTx(
  tx: DbTx,
  input: { organizationId: string; conversationId: string; messageId?: string; actorUserId: string; via?: AgentVia; now: Date },
): Promise<void> {
  if (input.via) return;
  const { organizationId, conversationId, actorUserId, now } = input;
  const scope = input.messageId ? sql`and k.message_id = ${input.messageId}::uuid` : sql``;
  await tx.execute(sql`
    insert into stop_reviews (organization_id, message_id, reviewed_by, reviewed_at)
    select distinct k.organization_id, k.message_id, ${actorUserId}::uuid, ${now.toISOString()}::timestamptz
    from reply_type_picks k
    where k.organization_id = ${organizationId} and k.conversation_id = ${conversationId} ${scope} and ${pickAsksToStopSql("k")}
    on conflict (message_id) do nothing`);
  const reply = input.messageId ? sql`${input.messageId}::uuid` : sql`(select r.latest_inbound_message_id from conversations r where r.id = ${conversationId} and r.organization_id = ${organizationId})`;
  await tx.execute(sql`
    insert into stop_reviews (organization_id, message_id, reviewed_by, reviewed_at)
    select m.organization_id, m.id, ${actorUserId}::uuid, ${now.toISOString()}::timestamptz
    from messages m
    where m.organization_id = ${organizationId} and m.id = ${reply} and ${wordsAskToStopSql("m")}
    on conflict (message_id) do nothing`);
}
