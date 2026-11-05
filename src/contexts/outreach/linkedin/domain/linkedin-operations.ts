// Pure rules for LinkedIn actions a vendor runs after it answered: what the settle job does with each one. No I/O.

export const OPEN_OPERATION_KINDS = ["invitation", "message", "lookup", "search", "reply_check"] as const;
export type OpenOperationKind = (typeof OPEN_OPERATION_KINDS)[number];

/** An action still waiting after this is cancelled. A queue that has held it this long will not free the account soon. */
export const OPERATION_TIMEOUT_MINUTES = 60;
/** A vendor that cannot answer about an action for this long has lost it, or the account. The action closes by its kind. */
export const OPERATION_GONE_HOURS = 24;
/** How long an action the vendor holds for its working hours stops the account. */
export const OPERATION_HELD_PAUSE_MINUTES = 60;
/** How long a lead waits after a look at its thread could not finish. Other leads of the account go first. */
export const REPLY_CHECK_RETRY_MINUTES = 60;
/** How far back a look at a thread reads when the lead's outreach start is unknown. */
export const REPLY_CHECK_DAYS = 30;
/** A smaller read than this waits for tomorrow, so that a one-row read does not hold the account. */
export const MIN_ASYNC_SEARCH_READ = 10;

export type OperationStep =
  /** Leave it for the next tick. */
  | "wait"
  /** Ask the vendor to stop it, because nobody wants the result. */
  | "cancel_stopped"
  /** Ask the vendor to stop it, because the vendor is holding it for its working hours. */
  | "cancel_held"
  /** Ask the vendor to stop it, because it ran too long. */
  | "cancel_timeout"
  /** Close it without the vendor: it has not answered for a day. */
  | "give_up";

const ageMinutes = (submittedAt: Date, now: Date) => (now.getTime() - submittedAt.getTime()) / 60_000;

/** What the settle job does with an action that has not finished. `read` is null when the vendor could not say. */
export function nextOperationStep(input: { submittedAt: Date; now: Date; read: { held: boolean } | null; subjectLive: boolean }): OperationStep {
  const age = ageMinutes(input.submittedAt, input.now);
  if (input.read === null) return age >= OPERATION_GONE_HOURS * 60 ? "give_up" : "wait";
  if (!input.subjectLive) return "cancel_stopped";
  if (input.read.held) return "cancel_held";
  return age >= OPERATION_TIMEOUT_MINUTES ? "cancel_timeout" : "wait";
}

/** Whether a read that could not answer has gone on too long, once a cancel could not be confirmed either. */
export const operationGone = (submittedAt: Date, now: Date) => ageMinutes(submittedAt, now) >= OPERATION_GONE_HOURS * 60;

/** How many people a search may ask for in its one read: what it still wants, within the account's allowance today. */
export function asyncSearchLimit(input: { maxResults: number; found: number; quotaLeft: number }): number {
  return Math.max(0, Math.min(input.maxResults - input.found, input.quotaLeft));
}

/** The note on a search the day's allowance cut short. Null when the read was not cut. */
export function allowanceCutNote(input: { wanted: number; limit: number; received: number }): string | null {
  if (input.limit >= input.wanted || input.received < input.limit) return null;
  return `Read ${input.received} people, this account's search allowance for today. A higher allowance, or narrower search URLs, reach the rest.`;
}
