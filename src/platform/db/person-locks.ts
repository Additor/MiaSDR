import { sql } from "drizzle-orm";
import type { DbHandle, DbTx } from "./client";

/*
 * Lock primitives for the transactions that change one person across contexts: the conversion (deals) and the leads use
 * cases of "Contacts and Companies CRUD" in docs/decisions.md. The person advisory lock and the lock timeouts are generic
 * and live here; the record locks belong to conversations (`person-handling.ts`), which owns `records`.
 *
 * A person transaction meets reply ingest, suppression and the send engine on the same person. It runs with a 5 s lock
 * timeout and runs once more on a deadlock or a lock timeout through `retryOnce` in ./errors.
 */

/** The lock timeout of a conversion transaction while it holds nothing of the person. */
export const CONVERSION_LOCK_TIMEOUT = "5s";
/**
 * The lock timeout once the conversion holds the person's records or advisory lock. `suppressEmail` (enrollments before
 * records), multi-person ingest (advisory before records) and `advanceRunTx` (run before record) take these locks in another
 * order, so a cycle with them can form at any later wait. Postgres resolves a cycle in the waiter whose `deadlock_timeout`
 * (1 s by default) runs out first, and those writers do not retry. A wait shorter than that makes the conversion give way first:
 * it rolls back, its caller runs it once more, and the other writer commits.
 */
export const HELD_LOCK_TIMEOUT = "300ms";

export const setLockTimeout = (tx: DbHandle, value: string) => tx.execute(sql.raw(`set local lock_timeout = '${value}'`));

/**
 * Serializes the writers that decide whether a person may receive outreach: the reply stop, the restore of a removed
 * lead and the person deletes. They read facts about the person (a reply, another active enrollment, a send) and then
 * write enrollments, and without a shared lock each reads the world before the other commits. The lock is
 * transaction-scoped and keyed on the person; several people are taken in id order so two callers cannot wait on each other.
 */
export async function lockPersonOutreachTx(tx: DbTx, organizationId: string, personIds: string[]): Promise<void> {
  for (const id of lockOrder(personIds)) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${outreachLockKey(organizationId, id)}, 0))`);
  }
}

/**
 * `lockPersonOutreachTx` for a batch, in one statement: the same keys in the same order (the JavaScript sort of the ids),
 * so it never waits in a cycle with the per-id version. Postgres takes the locks row by row as the function scan yields the
 * array, and `with ordinality` plus `order by` pin that order. One round trip for the batch instead of one per id.
 */
export async function lockPeopleOutreachTx(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<void> {
  const keys = lockOrder(personIds).map((id) => outreachLockKey(organizationId, id));
  if (keys.length === 0) return;
  await tx.execute(sql`
    select count(*) from (
      select pg_advisory_xact_lock(hashtextextended(k.key, 0))
      from jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) with ordinality as k(key, n)
      order by k.n
    ) locked`);
}

/**
 * The ids in lowercase, without repeats, sorted. Postgres prints a uuid in lowercase, and a request may send one in
 * uppercase (`z.uuid()` takes both), so the key must not depend on the case the caller had.
 */
const lockOrder = (personIds: readonly string[]) => [...new Set(personIds.map((id) => id.toLowerCase()))].sort();

const outreachLockKey = (organizationId: string, personId: string) => `person-outreach:${organizationId}:${personId}`;
