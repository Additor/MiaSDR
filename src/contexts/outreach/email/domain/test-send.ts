/** A mailbox may send this many test emails per window. Failed attempts count, because each one reached the provider. */
export const TEST_SEND_LIMIT = 3;
export const TEST_SEND_WINDOW_MINUTES = 60;
/** A test send still `sending` this recently blocks a second one, so a double click claims once. */
export const TEST_SEND_IN_FLIGHT_MINUTES = 2;

export const TEST_SUBJECT_TEMPLATE = "MiaSDR test email";
export const TEST_BODY_TEMPLATE = "This is a test email from {{mailbox}}, sent by MiaSDR to confirm the mailbox can send.\n\nSent at {{sentAt}} UTC. You can delete this message.";

/** Minutes until the oldest counted test send leaves the window, rounded up. */
export function minutesUntilTestSlot(oldestClaimedAt: Date, now: Date): number {
  const free = oldestClaimedAt.getTime() + TEST_SEND_WINDOW_MINUTES * 60_000;
  return Math.max(1, Math.ceil((free - now.getTime()) / 60_000));
}
