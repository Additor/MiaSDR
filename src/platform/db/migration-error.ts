/**
 * Drizzle wraps a failed migration statement in an error whose message is "Failed query: <the whole statement>" and keeps
 * the database's own message in `cause`. The pre-checks of the schema migrations put the useful text in that cause (table,
 * constraint, row count, a query that lists the rows), so surface it as the message.
 */
export function readableMigrationError(error: unknown): Error {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  if (current instanceof Error && current !== error) return new Error(`Migration failed: ${current.message}`, { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}
