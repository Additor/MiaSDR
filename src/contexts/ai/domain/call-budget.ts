/**
 * One model call's limits, for both adapters. The AI and grid jobs hold a 5-minute lease; a call that outlives it lets
 * a second worker run the same paid call. Every try timing out and every wait at its longest must stay under it.
 */
export const CALL_TIMEOUT_MS = 40_000;
/** Retries after the first try. */
export const CALL_RETRIES = 2;
/** The longest wait between tries: the Anthropic SDK honors `retry-after` up to 60 seconds; the fetch adapter caps at 30. */
export const RETRY_WAIT_CAP_MS = 60_000;

export const WORST_CASE_CALL_MS = (CALL_RETRIES + 1) * CALL_TIMEOUT_MS + CALL_RETRIES * RETRY_WAIT_CAP_MS;
