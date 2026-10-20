// Pure rules for replying to a LinkedIn chat from the inbox. No I/O.

/** LinkedIn's own limit for one message. */
export const MAX_LINKEDIN_REPLY = 8000;

/** A refusal for a limit pauses the account this long, as the sequence engine does. */
export const REPLY_PAUSE_HOURS = 24;

/** Seconds (0 turns the gap off) that must pass between two replies from one LinkedIn account, so a burst of clicks does not look like a bot. */
export const DEFAULT_REPLY_GAP_SECONDS = 8;
export const MIN_REPLY_GAP_SECONDS = 0;
export const MAX_REPLY_GAP_SECONDS = 600;

/** Normalizes line endings and trims. Returns the text or the reason it cannot be sent. */
export function checkReplyText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") return { ok: false, error: "The reply cannot be empty." };
  if (text.length > MAX_LINKEDIN_REPLY) return { ok: false, error: `The reply is longer than ${MAX_LINKEDIN_REPLY} characters.` };
  return { ok: true, text };
}

/** The per-organization pause between replies from `channel_settings.linkedin.replyGapSeconds`. Out-of-bound values fall back to the default. */
export function replyGapSeconds(stored: Record<string, unknown> | null | undefined): number {
  const raw = stored?.replyGapSeconds;
  const n = typeof raw === "number" ? raw : Number.NaN;
  return Number.isInteger(n) && n >= MIN_REPLY_GAP_SECONDS && n <= MAX_REPLY_GAP_SECONDS ? n : DEFAULT_REPLY_GAP_SECONDS;
}

export type ReplyBlock =
  | { reason: "not_connected"; message: string }
  | { reason: "paused"; message: string; until: Date }
  | { reason: "daily_cap"; message: string }
  | { reason: "too_fast"; message: string; retryAfterSeconds: number };

export interface ReplyAccountState {
  status: string;
  limitReachedUntil: Date | null;
  dailyMessageLimit: number;
}

/**
 * Whether the account may send one more reply now. Working hours do not apply to a reply a person types,
 * but a disconnected or paused account does, and so do the daily message cap and the gap between replies.
 * `usedToday` counts sequence messages and replies that went out or may have gone out since midnight UTC.
 */
export function replyBlock(
  now: Date,
  account: ReplyAccountState,
  usage: { usedToday: number; lastAttemptAt: Date | null; gapSeconds: number },
): ReplyBlock | null {
  if (account.status !== "connected") return { reason: "not_connected", message: "This LinkedIn account is not connected. Reconnect it in Settings, LinkedIn." };
  if (account.limitReachedUntil && account.limitReachedUntil.getTime() > now.getTime()) {
    return { reason: "paused", until: account.limitReachedUntil, message: `LinkedIn limited this account. Messages resume ${account.limitReachedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC.` };
  }
  if (usage.usedToday >= account.dailyMessageLimit) {
    return { reason: "daily_cap", message: `This account reached its daily limit of ${account.dailyMessageLimit} messages. Try again after midnight UTC or raise the limit.` };
  }
  if (usage.lastAttemptAt) {
    const wait = usage.lastAttemptAt.getTime() + usage.gapSeconds * 1000 - now.getTime();
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      return { reason: "too_fast", retryAfterSeconds, message: `Wait ${retryAfterSeconds} seconds before sending another message from this account.` };
    }
  }
  return null;
}

/** Start of the UTC day that contains `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
