import { sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { rowsOf } from "@/platform/db/sql-values";
import { publicConversationSql } from "@/platform/db/conversation-visibility";
import { detectsStopRequest } from "../domain/stop-request";

/**
 * True when the reply `messageId` asked to stop and a pick of it stored the flag (`response.stopRequested`). The AI's
 * pick stores it, and so does a person's pick of a reply whose text asks to stop (`replyAskedToStop`), so a later pick of
 * the same reply keeps it. The start sweep reads the fact here.
 */
export const stopRequestedSql = (messageId: SQL): SQL =>
  sql`exists (select 1 from reply_type_picks sp where sp.message_id = ${messageId} and (sp.response->>'stopRequested')::boolean)`;

/** True when a pick `alias` of a reply reads it as a request to stop: the stored flag, or the stop request type as its proposal. */
export const pickAsksToStopSql = (alias: string): SQL =>
  sql.raw(`(coalesce((${alias}.response->>'stopRequested')::boolean, false) or exists (select 1 from reply_types st where st.id = ${alias}.proposed_reply_type_id and st.system_role = 'stop_request'))`);

/**
 * True when a pick reads the reply `messageId` as a request to stop and no person reviewed it (`stop_reviews`). The agent send
 * gate and Actions read this one rule, so an agent is refused exactly while a person is asked. A pick's status plays no part:
 * an agent can move a pick, and only a person's review answers the question.
 */
export const stopReviewOpenSql = (messageId: SQL): SQL =>
  sql`(exists (select 1 from reply_type_picks so where so.message_id = ${messageId} and ${pickAsksToStopSql("so")})
    and not exists (select 1 from stop_reviews sr where sr.message_id = ${messageId}))`;

/**
 * True when the reply `messageId` asked to stop: a pick of it stored the flag, or its own words ask (`detectsStopRequest`).
 * The text check covers a reply no AI pick read yet, as when a person picks first or the organization has no AI provider.
 * The Change type outcomes, a person's type change and pick, and `loadStartOn` read the fact here.
 */
export async function replyAskedToStop(exec: DbHandle, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const [row] = rowsOf<{ asked: boolean; body: string | null }>(
    await exec.execute(sql`select ${stopRequestedSql(sql`${messageId}::uuid`)} as asked, (select m.body_text from messages m join conversations c on c.id = m.conversation_id where m.id = ${messageId}::uuid and ${publicConversationSql("c")}) as body`),
  );
  return row?.asked === true || detectsStopRequest(row?.body ?? "");
}

/**
 * The agent send gate's question about a reply: did it ask to stop, with no person's review since. Its own words count before
 * any pick reads them, so an agent cannot answer in the gap before classification, or where no AI provider ever reads it.
 */
export async function stopReviewOpen(exec: DbHandle, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const [row] = rowsOf<{ open: boolean; reviewed: boolean; body: string | null }>(
    await exec.execute(sql`select ${stopReviewOpenSql(sql`${messageId}::uuid`)} as open,
      exists (select 1 from stop_reviews sr where sr.message_id = ${messageId}::uuid) as reviewed,
      (select m.body_text from messages m where m.id = ${messageId}::uuid) as body`),
  );
  return row?.open === true || (row?.reviewed === false && detectsStopRequest(row.body ?? ""));
}
