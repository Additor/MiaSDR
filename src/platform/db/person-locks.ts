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
 * Serializes the writers that decide whether a person may receive outreach: the reply stop and the restore of a removed
 * lead. They read facts about the person (a reply, another active enrollment) and then write enrollments, and
 * without a shared lock each reads the world before the other commits. The lock is transaction-scoped and keyed on the
 * person; several people are taken in id order so two callers cannot wait on each other.
 */
export async function lockPersonOutreachTx(tx: DbTx, organizationId: string, personIds: string[]): Promise<void> {
  for (const id of [...new Set(personIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`person-outreach:${organizationId}:${id}`}, 0))`);
  }
}
