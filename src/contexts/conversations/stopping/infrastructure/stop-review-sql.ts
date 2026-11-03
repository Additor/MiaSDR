import { sql, type SQL } from "drizzle-orm";

/*
 * The stop review rule. Conversations owns it, and the baseline publishes it as two views: `stop_review_open_messages` and
 * `stop_review_open_people`. Outreach sits below conversations and gates enrollment on the rule inside its own SQL, so it
 * reads `stop_review_open_people` (`outreach/infrastructure/stop-review-gate.ts`) and never these tables.
 * `stop-contact.integration.test.ts` holds the two fragments below and the views to one reading.
 */

/** True when a pick `alias` of a reply reads it as a request to stop: the stored flag, or the stop request type as its proposal. */
export const pickAsksToStopSql = (alias: string): SQL =>
  sql.raw(`(coalesce((${alias}.response->>'stopRequested')::boolean, false) or exists (select 1 from reply_types st where st.id = ${alias}.proposed_reply_type_id and st.system_role = 'stop_request'))`);

/** True when the words of a message `alias` ask to stop, as ingest read them. It holds before any pick, and with no AI provider. */
export const wordsAskToStopSql = (alias: string): SQL => sql.raw(`coalesce(${alias}.raw->>'stopAsked', 'false') = 'true'`);

/**
 * True when the reply `messageId` asks to stop, in a pick's reading or in its own words, and no person reviewed it
 * (`stop_reviews`). The agent send gate, Actions and enrollment read this one rule, so an agent is refused exactly while a
 * person is asked. A pick's status plays no part: an agent can move a pick, and only a person's review answers the question.
 */
export const stopReviewOpenSql = (messageId: SQL): SQL => sql`exists (select 1 from stop_review_open_messages sro where sro.message_id = ${messageId})`;
