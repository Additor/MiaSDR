const MIN_SECRET_LENGTH = 6;

/** Replaces every occurrence of a credential value in a JSON-like value, so an API that echoes its key cannot leak it into the ledger. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const live = secrets
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    // A secret with a quote or backslash appears escaped inside serialized JSON.
    .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  if (live.length === 0 || value === undefined) return value;
  const scrub = (text: string) => live.reduce((acc, s) => acc.split(s).join("[redacted]"), text);
  return JSON.parse(scrub(JSON.stringify(value) ?? "null")) as T;
}

/** Keeps one enormous response out of grid_cell_runs. */
export function boundedAudit(value: unknown, maxBytes = 16 * 1024): unknown {
  try {
    const json = JSON.stringify(value);
    if (json && json.length > maxBytes) return { truncated: true, preview: json.slice(0, maxBytes) };
    return value ?? null;
  } catch {
    return null;
  }
}

/** Strips control characters and caps length, for error text stored on a cell. */
export function cleanError(message: string, secrets: readonly string[] = []): string {
  return redactSecrets(message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), secrets).slice(0, 500);
}
