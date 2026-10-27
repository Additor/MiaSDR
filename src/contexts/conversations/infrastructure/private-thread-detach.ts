import { sql } from "drizzle-orm";
import { publicConversationText } from "@/platform/db/conversation-visibility";
import type { DbTx as Tx } from "@/platform/db/client";
import { rowsOf } from "@/platform/db/sql-values";
import { RETIRABLE_DRAFT_STATUSES } from "../domain/draft-status";
import { sqlValues } from "@/platform/db/sql-values";
import { lockBeforePick } from "../domain/reply-handling";

/**
 * An older public thread turns private when its person answers a personal campaign. The thread already moved the
 * shared record (workflow state, latest-inbound pointer, drafts, a classification, queue item), so those effects are
 * undone here, in the same transaction as the flip. What the shared record shows afterwards comes from the record's
 * other public conversations only.
 *
 * - Open drafts and proposed classifications of the thread turn `stale`; queued AI jobs for its messages fail.
 * - When `latest_inbound_message_id` points into the thread, it moves to the newest inbound message of the record's other
 *   public conversations (or clears), `last_inbound_at` follows, and the context version bumps. A category an AI applied
 *   to that message goes back to the value it replaced.
 * - A record that was `action_required` because of the thread goes back to `unclassified` (no category) or `idle`, and
 *   its next-action time clears, so the queue and next-step lists drop it.
 */
export async function detachPrivateThreadTx(tx: Tx, input: { organizationId: string; conversationId: string; recordId: string; now: Date }): Promise<void> {
  const at = sql`${input.now.toISOString()}::timestamptz`;
  const reason = "The conversation became private.";
  const [record] = rowsOf<{ latest: string | null; state: string; group_key: string | null; reply_type_id: string | null; reply_type_locked: boolean; context_version: number }>(
    await tx.execute(sql`
      select latest_inbound_message_id as latest, workflow_state as state, group_key, reply_type_id, reply_type_locked, context_version
      from records where id = ${input.recordId} and organization_id = ${input.organizationId} for update`),
  );
  if (!record) return;

  await tx.execute(sql`
    update drafts set status = 'stale', error = ${reason}, updated_at = ${at}
    where organization_id = ${input.organizationId} and conversation_id = ${input.conversationId} and status in ${sqlValues(RETIRABLE_DRAFT_STATUSES)}`);
  await tx.execute(sql`
    update reply_type_picks set status = 'stale'
    where organization_id = ${input.organizationId} and status = 'proposed'
      and message_id in (select id from messages where conversation_id = ${input.conversationId})`);
  await tx.execute(sql`
    update ai_jobs set status = 'failed', failed_at = ${at}, last_error = ${reason}
    where organization_id = ${input.organizationId} and status = 'queued'
      and ((kind = 'classification' and entity_type = 'message' and entity_id in (select id from messages where conversation_id = ${input.conversationId}))
        or (kind = 'initial_draft' and entity_type = 'classification'
            and entity_id in (select k.id from reply_type_picks k join messages m on m.id = k.message_id where m.conversation_id = ${input.conversationId})))`);

  if (!record.latest) return;
  const [inThread] = rowsOf<{ one: number }>(
    await tx.execute(sql`select 1 as one from messages where id = ${record.latest} and conversation_id = ${input.conversationId}`),
  );
  if (!inThread) return;

  const [remaining] = rowsOf<{ id: string; sent_at: Date | string }>(
    await tx.execute(sql`
      select m.id, m.sent_at from messages m join conversations c on c.id = m.conversation_id
      where c.record_id = ${input.recordId} and ${sql.raw(publicConversationText("c"))} and m.direction = 'inbound'
      order by m.sent_at desc, m.id limit 1`),
  );
  // A type the AI applied for the private message goes back to what it replaced, with the lock it had then.
  const [applied] = rowsOf<{
    previous_group_key: string | null;
    previous_reply_type_id: string | null;
    applied_group_key: string;
    applied_reply_type_id: string | null;
    response: unknown;
  }>(
    await tx.execute(sql`
      select k.previous_group_key, k.previous_reply_type_id, k.applied_group_key, k.applied_reply_type_id, k.response
      from reply_type_picks k
      where k.record_id = ${input.recordId} and k.message_id = ${record.latest} and k.status = 'auto_applied' and k.applied_group_key is not null
      order by k.created_at desc limit 1`),
  );
  const revert = Boolean(applied && applied.applied_group_key === record.group_key && applied.applied_reply_type_id === record.reply_type_id);
  const previous = revert && applied ? applied.previous_group_key : record.group_key;
  const previousSub = revert && applied ? (previous ? applied.previous_reply_type_id : null) : record.reply_type_id;
  const locked = revert && applied ? previous !== null && lockBeforePick(applied.response, previous) : record.reply_type_locked;
  const nextState = record.state === "action_required" ? (remaining ? "action_required" : previous ? "idle" : "unclassified") : record.state;

  await tx.execute(sql`
    update records set
      latest_inbound_message_id = ${remaining?.id ?? null},
      last_inbound_at = ${remaining ? sql`${new Date(remaining.sent_at).toISOString()}::timestamptz` : sql`null`},
      group_key = ${previous}, reply_type_id = ${previousSub},
      reply_type_source = case when ${previous}::text is null then null when ${revert}::boolean then 'human' else reply_type_source end,
      reply_type_locked = ${locked},
      workflow_state = ${nextState},
      next_action_at = case when ${nextState}::text = ${record.state}::text then next_action_at else null end,
      context_version = context_version + 1
    where id = ${input.recordId} and organization_id = ${input.organizationId}`);
}
