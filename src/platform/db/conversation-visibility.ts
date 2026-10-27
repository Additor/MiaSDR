import { isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { conversations } from "@/platform/db/schema";

/**
 * The one read-side rule for private conversations. A conversation that belongs to a personal campaign carries
 * `private_campaign_id`; the Inbox, its counts, the CRM, the reply flows and the AI loaders must not see it.
 * Every query that reads `conversations` uses one of these two forms (conversation-visibility.test.ts enforces it).
 * The only reader that skips the rule is the campaign's own thread view (drizzle-personal-thread-store.ts).
 */

/** For drizzle queries over the `conversations` table. */
export const publicConversation: SQL = isNull(conversations.privateCampaignId);

/** The same rule as text, for queries built from strings. `alias` is the alias (or table name) the query gives `conversations`. */
export const publicConversationText = (alias: string): string => `${alias}.private_campaign_id is null`;

/** For `sql` templates. */
export const publicConversationSql = (alias: string): SQL => sql.raw(publicConversationText(alias));

/**
 * A record whose only conversations are private exists as the parent row of a private thread and nothing else (a
 * conversation needs a record). CRM readers skip it. A record with a public conversation, or with no conversation at
 * all, stays visible. `alias` is the alias (or table name) the query gives `records`.
 */
export const visibleRecordText = (alias: string): string =>
  `(exists (select 1 from conversations vc where vc.record_id = ${alias}.id and ${publicConversationText("vc")}) or not exists (select 1 from conversations vc2 where vc2.record_id = ${alias}.id))`;

export const visibleRecordSql = (alias: string): SQL => sql.raw(visibleRecordText(alias));

/**
 * A note or task reached through its person: written on no record, or on a visible record. One written on a record whose
 * only threads are private stays with that private thread. `recordId` is the row's record column.
 */
export const onVisibleRecordSql = (recordId: AnyColumn): SQL =>
  sql`(${recordId} is null or exists (select 1 from records r where r.id = ${recordId} and ${visibleRecordSql("r")}))`;

/** A draft of a private conversation is not shown. A draft with no conversation is. `alias` is the alias of `drafts`. */
export const visibleDraftText = (alias: string): string =>
  `(${alias}.conversation_id is null or exists (select 1 from conversations dc where dc.id = ${alias}.conversation_id and ${publicConversationText("dc")}))`;

export const visibleDraftSql = (alias: string): SQL => sql.raw(visibleDraftText(alias));

/** A classification of a message in a private conversation is not shown. `alias` is the alias of `reply_type_picks`. */
export const visibleReplyTypePickText = (alias: string): string =>
  `exists (select 1 from messages km join conversations kc on kc.id = km.conversation_id where km.id = ${alias}.message_id and ${publicConversationText("kc")})`;

export const visibleReplyTypePickSql = (alias: string): SQL => sql.raw(visibleReplyTypePickText(alias));
