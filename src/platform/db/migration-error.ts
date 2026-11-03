import { rootCause } from "@/shared/error-text";

/**
 * Drizzle wraps a failed migration statement in an error whose message is "Failed query: <the whole statement>" and keeps
 * the database's own message in `cause`. The pre-checks of the schema migrations put the useful text in that cause (table,
 * constraint, row count, a query that lists the rows), so surface it as the message.
 */
export function readableMigrationError(error: unknown): Error {
  const root = rootCause(error);
  if (root instanceof Error && root !== error) return new Error(`Migration failed: ${root.message}`, { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}
