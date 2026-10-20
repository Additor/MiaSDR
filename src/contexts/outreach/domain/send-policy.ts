import { isWithinWorkingHours, type WorkingHours } from "./working-hours";

export const DEFAULT_GAP_MINUTES: [number, number] = [18, 24];
const GAP_BOUNDS = { min: 1, max: 240 };

/** Why a gap range is unusable, or null when it is valid. Both bounds are whole minutes, 1 to 240, and min <= max. */
export function sendGapProblem(lo: unknown, hi: unknown): string | null {
  if (typeof lo !== "number" || typeof hi !== "number" || !Number.isInteger(lo) || !Number.isInteger(hi)) {
    return "The gap is a whole number of minutes.";
  }
  if (lo < GAP_BOUNDS.min || hi > GAP_BOUNDS.max || hi < GAP_BOUNDS.min || lo > GAP_BOUNDS.max) {
    return `The gap is between ${GAP_BOUNDS.min} and ${GAP_BOUNDS.max} minutes.`;
  }
  if (lo > hi) return "The shortest gap cannot be longer than the longest.";
  return null;
}

export const DEFAULT_TAKEOVER_HOURS = 24;
const TAKEOVER_BOUNDS = { min: 1, max: 168 };

/** Why a takeover delay is unusable, or null when it is valid. Whole hours, 1 to 168 (one week). */
export function takeoverHoursProblem(hours: unknown): string | null {
  if (typeof hours !== "number" || !Number.isInteger(hours)) return "The takeover delay is a whole number of hours.";
  if (hours < TAKEOVER_BOUNDS.min || hours > TAKEOVER_BOUNDS.max) {
    return `The takeover delay is between ${TAKEOVER_BOUNDS.min} and ${TAKEOVER_BOUNDS.max} hours.`;
  }
  return null;
}

/** Per-organization email rules. Out-of-bound stored values fall back to the defaults. */
export function emailRules(stored: Record<string, unknown> | null | undefined): { sendGapMinutes: [number, number]; takeoverAfterHours: number } {
  const hours = stored?.takeoverAfterHours;
  const takeoverAfterHours = takeoverHoursProblem(hours) === null ? (hours as number) : DEFAULT_TAKEOVER_HOURS;
  const raw = stored?.sendGapMinutes;
  if (Array.isArray(raw) && raw.length === 2) {
    const [lo, hi] = raw.map(Number);
    if (sendGapProblem(lo, hi) === null) return { sendGapMinutes: [lo, hi], takeoverAfterHours };
  }
  return { sendGapMinutes: DEFAULT_GAP_MINUTES, takeoverAfterHours };
}

/** Uniform integer in [lo, hi]. `random` returns [0, 1). */
export function pickGapMinutes([lo, hi]: [number, number], random: () => number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

export type MailboxBlock = "not_connected" | "throttled" | "outside_hours" | "daily_limit";

export interface MailboxState {
  status: string;
  nextSendAt: Date | null;
  dailySendLimit: number;
  /** Sends claimed since the start of the mailbox's local day. */
  sentToday: number;
  workingHours: WorkingHours;
}

/** Why a mailbox may not send right now, or null when it may. */
export function mailboxBlock(now: Date, mailbox: MailboxState): MailboxBlock | null {
  if (mailbox.status !== "connected") return "not_connected";
  if (mailbox.nextSendAt && mailbox.nextSendAt.getTime() > now.getTime()) return "throttled";
  if (!isWithinWorkingHours(now, mailbox.workingHours)) return "outside_hours";
  if (mailbox.sentToday >= mailbox.dailySendLimit) return "daily_limit";
  return null;
}

export const MAX_SEND_ATTEMPTS = 3;
/** Wait before retrying a definite failure: 15 minutes, then 30. */
export function retryDelayMinutes(attemptJustFailed: number): number {
  return 15 * attemptJustFailed;
}
/** An unresolved send older than this is looked up in the mailbox instead of trusted. */
export const UNCERTAIN_AFTER_MINUTES = 10;
/** A send still missing from the mailbox after this long is treated as not sent. */
export const NOT_FOUND_GRACE_MINUTES = 30;

/** Days after the previous step, as milliseconds, for the next step's due time. */
export function dueAfterDays(from: Date, waitDays: number): Date {
  return new Date(from.getTime() + waitDays * 24 * 60 * 60 * 1000);
}
