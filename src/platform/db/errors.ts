import { ConflictError } from "@/shared/errors";

/*
 * Database errors as application code sees them. The module imports no driver and no schema, so application use cases
 * may import it: they decide to retry or answer 409 from a SQLSTATE without touching the database themselves.
 * A person transaction runs once more on a deadlock (40P01) or a lock timeout (55P03); a second failure answers 409 `try_again`.
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
