/** The day the daily agent limits count: from midnight UTC. */
export const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day that contains `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
