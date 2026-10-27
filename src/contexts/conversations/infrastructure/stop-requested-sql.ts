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
