import { sql, type SQL } from "drizzle-orm";

/**
 * True when the reply `messageId` asked to stop: an AI pick of that message flagged it (`response.stopRequested`). Only
 * the AI's picks carry the flag, so a person's later pick of the same reply keeps it. The Change type outcomes, a
 * person's pick and the start of follow-ups all read the fact here.
 */
export const stopRequestedSql = (messageId: SQL): SQL =>
  sql`exists (select 1 from reply_type_picks sp where sp.message_id = ${messageId} and (sp.response->>'stopRequested')::boolean)`;
