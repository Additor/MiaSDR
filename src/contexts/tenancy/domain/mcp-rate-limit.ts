/**
 * MCP request limits. Each token counts its requests per bucket in fixed one-minute windows. Read tools share the
 * `read` bucket; the write and send tools bring their own buckets when they ship.
 */
export const MCP_RATE_WINDOW_MS = 60_000;

export const MCP_RATE_LIMITS = { read: 60 } as const;
export type McpRateBucket = keyof typeof MCP_RATE_LIMITS;

/** Failed guesses at a well-formed token one client IP may make per window before it waits. */
export const MCP_BAD_TOKEN_LIMIT = 20;

/** The start of the window that holds `now`. */
export const rateWindowStart = (now: Date): Date => new Date(Math.floor(now.getTime() / MCP_RATE_WINDOW_MS) * MCP_RATE_WINDOW_MS);

/** Whole seconds until the window that holds `now` ends, at least 1. */
export const rateRetryAfterSeconds = (now: Date): number =>
  Math.max(1, Math.ceil((rateWindowStart(now).getTime() + MCP_RATE_WINDOW_MS - now.getTime()) / 1000));
