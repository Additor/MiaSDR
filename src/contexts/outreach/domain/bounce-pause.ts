/**
 * The bounce circuit breaker: a verified hard bounce pauses an email campaign once too many of the sends since it last
 * started or resumed bounced. Fixed numbers, no setting. No I/O.
 */

/** A campaign pauses at this share of bounces, or above. */
export const BOUNCE_PAUSE_PERCENT = 5;
/** Below this many sends the rate says little, so nothing pauses. */
export const BOUNCE_PAUSE_MIN_SENDS = 20;

/** Sends since the campaign last started or resumed, and how many of them bounced. */
export interface BounceCount {
  sent: number;
  bounced: number;
}

/** What `campaigns.bounce_pause` stores: the count that paused the campaign. Null on any campaign the breaker did not pause. */
export interface BouncePause extends BounceCount {
  at: string;
}

/** Whole numbers on both sides, so 1 of 20 is exactly the limit. */
export const bouncesTripPause = ({ sent, bounced }: BounceCount): boolean => sent >= BOUNCE_PAUSE_MIN_SENDS && bounced * 100 >= BOUNCE_PAUSE_PERCENT * sent;

/** The rate with at most one decimal: 5, 7.5. */
export const bouncePercent = ({ sent, bounced }: BounceCount): number => (sent === 0 ? 0 : Math.round((bounced / sent) * 1000) / 10);

const counted = (count: BounceCount) => `${count.bounced} of ${count.sent} emails bounced (${bouncePercent(count)}%)`;

/** Why the campaign stopped, for the campaign page, Actions and an agent's read. */
export const bouncePauseReason = (count: BounceCount): string =>
  `MiaSDR paused this campaign because ${counted(count)} since it last started. A campaign pauses at ${BOUNCE_PAUSE_PERCENT}% with at least ${BOUNCE_PAUSE_MIN_SENDS} sends.`;

/** The resume dialog's description. */
export const bounceResumeLine = (count: BounceCount): string =>
  `${counted(count)} since this campaign last started. Resuming sends to the remaining leads and starts a new count, so it pauses again at ${BOUNCE_PAUSE_PERCENT}% with at least ${BOUNCE_PAUSE_MIN_SENDS} new sends.`;
