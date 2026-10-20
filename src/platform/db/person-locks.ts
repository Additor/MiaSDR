import { and, eq, sql } from "drizzle-orm";
import { ConflictError } from "@/shared/errors";
import type { DbHandle } from "./client";
import { records } from "./schema";
import { lockPersonOutreachTx, type Tx } from "./sequence-stop";

/*
 * Lock helpers for the transactions that change one person across contexts: the conversion (deals) and, next, the leads
 * use cases of "Contacts and Companies CRUD" in docs/decisions.md. They live in shared so leads can use them without importing
 * deals. The file imports no context: the record lock is written over the shared schema, in the order of conversations'
 * `lockPersonRecordRows`.
 *
 * A person transaction meets reply ingest, suppression and the send engine on the same person. It runs with a 5 s lock
 * timeout and runs once more on a deadlock (40P01) or a lock timeout (55P03); a second failure answers 409 `try_again`.
 */

/** Retries taken after a deadlock or lock timeout, for tests that need to see whether Postgres picked the conversion. */
export const lockRetryStats = { retries: 0 };

/** The SQLSTATE of a driver error, also under a wrapping error's `cause`. */
export function sqlState(error: unknown): string | null {
  let current = error as { code?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = current.cause as typeof current;
  }
  return null;
}

export const isRetryableLockError = (error: unknown) => {
  const code = sqlState(error);
  return code === "40P01" || code === "55P03";
};

export const TRY_AGAIN = "Another change to this person is in progress. Try again in a moment.";

/** Runs `run` once more after a deadlock or lock timeout. A second one answers 409 `try_again`. */
export async function retryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRetryableLockError(error)) throw error;
  }
  lockRetryStats.retries += 1;
  try {
    return await run();
  } catch (error) {
    if (isRetryableLockError(error)) throw new ConflictError(TRY_AGAIN, { code: "try_again" });
    throw error;
  }
}

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
 * Step 1 of the conversion, the order of `lockPersonRecords`: the person's records `FOR UPDATE` in id order (waiting up to 5 s,
 * holding nothing), then the person's outreach advisory lock. Single-person ingest takes the same order. Do not contact
 * (`setDoNotContact`) takes another: `dnc:{personId}`, its `contact_policies` row through the upsert, then the records, runs
 * and enrollments, so it holds the policy row while it waits on the records. A contact delete locks the records first and the
 * policy row later; when the two meet, the delete's held-lock timeout makes it give way and run once more.
 */
export async function lockPersonForConversion(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  const locked = await tx
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.organizationId, organizationId), eq(records.personId, personId)))
    .orderBy(records.id)
    .for("update");
  if (locked.length > 0) await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
  await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
}
