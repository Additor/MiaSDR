import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { inTransaction, type DbHandle, type DbTx } from "@/platform/db/client";
import { people } from "@/platform/db/schema";

/**
 * A lead can be enrolled; a contact cannot ("Leads and CRM" in docs/decisions.md). Every candidate select of an enroll
 * path adds this fragment. Qualified by hand: a single-table select renders bare column names, which a subquery would bind
 * to its own table. It needs `people` in the FROM clause under that name.
 */
export const notContactSql = sql`(people.lifecycle <> 'contact')`;

/** The message of the `campaign_enrollments` triggers (migration 0025). SQLSTATE 23514 is shared with every CHECK, so match the message. */
export const CONTACT_ENROLL_MESSAGE = "contact_cannot_be_enrolled";

export function isContactEnrollError(error: unknown): boolean {
  // drizzle wraps the driver error: the Postgres message is on `cause`.
  let e = error as { message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 3; depth += 1) {
    if (e.message === CONTACT_ENROLL_MESSAGE) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Times a chunk was rolled back and re-selected. The trigger is the last guard, so a test reads this to prove a candidate select did its job. */
export const contactGuardStats = { retries: 0 };

/**
 * Inserts one chunk of enrollments in a savepoint. A person who became a contact after the candidate read makes the trigger fail
 * the chunk; the savepoint rolls it back, the chunk is re-selected with `notContactSql` (rows locked `for share`, so a conversion
 * in flight finishes first and a later one waits for this transaction) and inserted again. Returns the rows `insert` returned and
 * the people dropped. `insert` receives the ids in `person_id` order and must build its rows from them, because it can run twice.
 */
export async function insertSkippingContacts<T>(
  tx: DbHandle,
  organizationId: string,
  personIds: string[],
  insert: (sp: DbTx, ids: string[]) => Promise<T[]>,
): Promise<{ inserted: T[]; skippedContact: number }> {
  let ids = [...personIds].sort();
  let skippedContact = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const chunk = ids;
      return { inserted: chunk.length === 0 ? [] : await inTransaction(tx, (sp) => insert(sp, chunk)), skippedContact };
    } catch (error) {
      if (!isContactEnrollError(error) || attempt >= 2) throw error;
      contactGuardStats.retries += 1;
      const kept = await tx
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.organizationId, organizationId), inArray(people.id, ids), notContactSql))
        .orderBy(asc(people.id))
        .for("share");
      skippedContact += ids.length - kept.length;
      ids = kept.map((r) => r.id);
    }
  }
}
