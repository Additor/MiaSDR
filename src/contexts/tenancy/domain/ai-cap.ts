/**
 * Daily limit on AI jobs (classification and draft) for replies from senders the organization never wrote to.
 * Stored as `unknownSenderAiDailyCap` in the organization's `general` channel settings.
 */
export const UNKNOWN_SENDER_AI_CAP_KEY = "unknownSenderAiDailyCap";
export const DEFAULT_UNKNOWN_SENDER_AI_DAILY_CAP = 50;
export const MAX_UNKNOWN_SENDER_AI_DAILY_CAP = 10_000;

/** The stored value, or the default when it is missing or not a whole number in range. 0 is valid and blocks unknown senders. */
export function readUnknownSenderAiCap(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_UNKNOWN_SENDER_AI_DAILY_CAP ? raw : DEFAULT_UNKNOWN_SENDER_AI_DAILY_CAP;
}

export const unknownSenderAiCapProblem = (value: unknown): string | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UNKNOWN_SENDER_AI_DAILY_CAP
    ? null
    : `The daily limit must be a whole number from 0 to ${MAX_UNKNOWN_SENDER_AI_DAILY_CAP}.`;
