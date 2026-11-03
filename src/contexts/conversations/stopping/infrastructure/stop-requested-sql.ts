import { sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { rowsOf, uuidList } from "@/platform/db/sql-values";
import { stopReviewOpenSql, wordsAskToStopSql } from "./stop-review-sql";

/**
 * True when the reply `messageId` asked to stop and a pick of it stored the flag (`response.stopRequested`). The AI's
 * pick stores it, and so does a person's pick of a reply whose text asks to stop (`replyAskedToStop`), so a later pick of
 * the same reply keeps it. The start sweep reads the fact here.
 */
export const stopRequestedSql = (messageId: SQL): SQL =>
  sql`exists (select 1 from reply_type_picks sp where sp.message_id = ${messageId} and (sp.response->>'stopRequested')::boolean)`;

/**
 * True when the reply `messageId` asked to stop: a pick of it stored the flag, or ingest read its words as asking
 * (`raw.stopAsked`). The stored words cover a reply no AI pick read yet, as when a person picks first or the organization
 * has no AI provider. The Change type outcomes, a person's type change and pick, `loadStartOn` and the lead checks read the fact here.
 */
export const replyAskedToStopSql = (messageId: SQL): SQL =>
  sql`(${stopRequestedSql(messageId)} or exists (select 1 from messages am where am.id = ${messageId} and ${wordsAskToStopSql("am")}))`;

/** `replyAskedToStopSql` for one reply. */
export async function replyAskedToStop(exec: DbHandle, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const [row] = rowsOf<{ asked: boolean }>(await exec.execute(sql`select ${replyAskedToStopSql(sql`${messageId}::uuid`)} as asked`));
  return row?.asked === true;
}

/** The agent send gate's question about a reply: did it ask to stop, with no person's review since (`stopReviewOpenSql`). */
export async function stopReviewOpen(exec: DbHandle, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const [row] = rowsOf<{ open: boolean }>(await exec.execute(sql`select ${stopReviewOpenSql(sql`${messageId}::uuid`)} as open`));
  return row?.open === true;
}

/** Replies per call that the check of a stop request reads, newest first. */
const STOP_CHECK_REPLIES = 500;

/** The people among `personIds` with a reply that asked to stop (`replyAskedToStopSql`). It reads every conversation of the person. */
export async function peopleWhoAskedToStop(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<string[]> {
  if (personIds.length === 0) return [];
  const rows = rowsOf<{ person_id: string; asked: boolean }>(
    await tx.execute(sql`
      select r.person_id, ${replyAskedToStopSql(sql`m.id`)} as asked
      from messages m
      join threads c on c.id = m.thread_id
      join conversations r on r.id = c.conversation_id
      where r.organization_id = ${organizationId} and r.person_id in ${uuidList(personIds)} and m.direction = 'inbound'
      order by m.sent_at desc nulls last
      limit ${STOP_CHECK_REPLIES}`),
  );
  return [...new Set(rows.filter((row) => row.asked).map((row) => row.person_id))];
}
