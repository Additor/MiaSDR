import { sql, type SQL } from "drizzle-orm";
import { AUTOMATED_SENDER_PATTERN, AUTOMATED_SUBJECT_PATTERN } from "../domain/inbox-filter";

/** Escapes `%`, `_` and `\` so user text matches literally inside LIKE. */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const flag = (alias: string, key: string) => sql.raw(`coalesce(${alias}.raw->>'${key}', 'false') = 'true'`);

/** The header marks the message as an automatic reply. */
export const autoReplyFlag = (alias: string): SQL => flag(alias, "autoReply");

/** The sender or subject reads like machine mail (no-reply, DMARC, delivery failure). */
export const automatedByPattern = (alias: string): SQL =>
  sql`(coalesce(${sql.raw(alias)}.from_address, '') ~* ${AUTOMATED_SENDER_PATTERN}::text or coalesce(${sql.raw(alias)}.subject, '') ~* ${AUTOMATED_SUBJECT_PATTERN}::text)`;

/**
 * An inbound message that never counts as unread: an auto-reply by header, or machine mail by pattern.
 * A possible bounce stays countable so someone looks at a notice the system could not verify.
 */
export const excludedFromUnread = (alias: string): SQL =>
  sql`(${autoReplyFlag(alias)} or (${automatedByPattern(alias)} and not ${flag(alias, "possibleBounce")}))`;
