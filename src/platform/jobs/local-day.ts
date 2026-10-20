const formatters = new Map<string, Intl.DateTimeFormat>();

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar day (yyyy-mm-dd) that `now` falls on in `timeZone`. An unknown
 * or empty zone falls back to UTC. Intl applies the zone's DST rules, so a
 * 23 or 25 hour day is still one day.
 */
export function localDay(now: Date, timeZone: string | null | undefined): string {
  const zone = timeZone && isKnownTimeZone(timeZone) ? timeZone : "UTC";
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
