/**
 * The deepest `cause` of an error. Drizzle wraps a failed statement in an error whose message is "Failed query: <sql>\nparams:
 * <values>" and keeps the database's own message in `cause`.
 */
export function rootCause(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  return current;
}

/** What stored failures and logs keep: the reason a person can act on, never the statement or its values. */
export function errorText(error: unknown): string {
  const root = rootCause(error);
  return root instanceof Error ? root.message : String(root);
}
