/**
 * MCP request limits. Each token counts its requests per bucket in fixed windows. Every request counts in `read`; a
 * tool that changes data also counts in `write`, and the costly actions count in `ai` (a model call on the
 * organization's AI key) or `import` as well. A sent reply counts in `send`, a campaign start or resume in `launch`, a
 * started enrichment or LinkedIn search in `spend`, an action a person cannot undo in `irreversible`.
 */
export const MCP_RATE_WINDOW_MS = 60_000;
const HOUR_MS = 60 * MCP_RATE_WINDOW_MS;

export const MCP_RATE_LIMITS = {
  read: { limit: 60, windowMs: MCP_RATE_WINDOW_MS },
  write: { limit: 20, windowMs: MCP_RATE_WINDOW_MS },
  ai: { limit: 60, windowMs: HOUR_MS },
  import: { limit: 10, windowMs: HOUR_MS },
  send: { limit: 10, windowMs: MCP_RATE_WINDOW_MS },
  launch: { limit: 10, windowMs: HOUR_MS },
  spend: { limit: 20, windowMs: HOUR_MS },
  irreversible: { limit: 30, windowMs: HOUR_MS },
} as const;
export type McpRateBucket = keyof typeof MCP_RATE_LIMITS;

/** Failed guesses at a well-formed token one client IP may make per window before it waits. */
export const MCP_BAD_TOKEN_LIMIT = 20;

/** The start of the window that holds `now`. */
export const rateWindowStart = (now: Date, windowMs: number = MCP_RATE_WINDOW_MS): Date => new Date(Math.floor(now.getTime() / windowMs) * windowMs);

/** Whole seconds until the window that holds `now` ends, at least 1. */
export const rateRetryAfterSeconds = (now: Date, windowMs: number = MCP_RATE_WINDOW_MS): number =>
  Math.max(1, Math.ceil((rateWindowStart(now, windowMs).getTime() + windowMs - now.getTime()) / 1000));
