import { sql, type SQL } from "drizzle-orm";

/** True when a pick `alias` of a reply reads it as a request to stop: the stored flag, or the stop request type as its proposal. */
export const pickAsksToStopSql = (alias: string): SQL =>
  sql.raw(`(coalesce((${alias}.response->>'stopRequested')::boolean, false) or exists (select 1 from reply_types st where st.id = ${alias}.proposed_reply_type_id and st.system_role = 'stop_request'))`);

/**
 * True when a pick reads the reply `messageId` as a request to stop and no person reviewed it (`stop_reviews`). The agent send
 * gate, Actions and enrollment read this one rule, so an agent is refused exactly while a person is asked. A pick's status
 * plays no part: an agent can move a pick, and only a person's review answers the question.
 */
export const stopReviewOpenSql = (messageId: SQL): SQL =>
  sql`(exists (select 1 from reply_type_picks so where so.message_id = ${messageId} and ${pickAsksToStopSql("so")})
    and not exists (select 1 from stop_reviews sr where sr.message_id = ${messageId}))`;

/** The same rule for a person: the latest reply of one of their records waits on that review. `alias` names `people`. */
export const personStopReviewOpenSql = (alias: string): SQL =>
  sql`exists (select 1 from records srr where srr.person_id = ${sql.raw(alias)}.id and srr.organization_id = ${sql.raw(alias)}.organization_id
    and ${stopReviewOpenSql(sql`srr.latest_inbound_message_id`)})`;
