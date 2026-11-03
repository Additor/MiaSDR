import { sql, type SQL } from "drizzle-orm";

/**
 * Enrollment's gate on a stop request: the latest reply of one of the person's conversations waits on a person's review.
 * Conversations owns the rule and publishes it as the view `stop_review_open_people`, because this SQL runs inside
 * outreach's enrollment statements and outreach sits below conversations. `alias` names `people`.
 */
export const personStopReviewOpenSql = (alias: string): SQL =>
  sql.raw(`exists (select 1 from stop_review_open_people srp where srp.person_id = ${alias}.id and srp.organization_id = ${alias}.organization_id)`);
