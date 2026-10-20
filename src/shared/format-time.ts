/**
 * Deterministic timestamp text. Server and browser must print the same string, so every function takes an explicit
 * IANA zone and builds the text from numeric parts. Nothing reads the viewer's locale or zone. A value that is not a
 * valid date formats as an empty string.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try {
      formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    } catch {
      // An unknown zone prints in UTC rather than throwing during render.
      formatter = formatters.get("UTC") ?? new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
      formatters.set("UTC", formatter);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function parts(value: Date | string | number, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const byType: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) byType[part.type] = part.value;
  return { date: `${byType.year.padStart(4, "0")}-${byType.month}-${byType.day}`, time: `${byType.hour}:${byType.minute}` };
}

/** "2026-03-08 14:05" in the given IANA zone (UTC when the zone is unknown). */
export function formatDateTime(value: Date | string | number, timeZone: string): string {
  const p = parts(value, timeZone);
  return p ? `${p.date} ${p.time}` : "";
}

/** "2026-03-08" in the given IANA zone (UTC when the zone is unknown). */
export function formatDate(value: Date | string | number, timeZone: string): string {
  return parts(value, timeZone)?.date ?? "";
}

/** "2026-03-08 14:05 UTC". Used as the tooltip so the stored instant stays visible next to the organization-zone text. */
export function formatUtc(value: Date | string | number): string {
  const text = formatDateTime(value, "UTC");
  return text && `${text} UTC`;
}

/**
 * Relative time (for example a Last contact column): "just now", "5 min ago", "3 h ago", "yesterday", "12 d ago", "5 mo ago",
 * "2 y ago". `now` is passed in, so the server and the browser print the same text for one render.
 */
export function relativeTime(value: Date | string | number, now: Date | string | number): string {
  const then = new Date(value).getTime();
  const base = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(base)) return "";
  const seconds = Math.round((base - then) / 1000);
  if (seconds < -60) return "soon";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} d ago`;
  // A 30-day month reaches 12 at day 360, five days before the year branch. Those days read as 11 months.
  if (days < 365) return `${Math.min(Math.floor(days / 30), 11)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/**
 * How long ago `value` was, without "ago": "under a minute", "5 min", "3 h", "2 d", "5 mo", "2 y". `long` spells the unit out
 * for a sentence ("5 minutes", "3 hours", "2 days", "5 months", "2 years"). A time in the future reads as "under a minute".
 */
export function elapsed(value: Date | string | number, now: Date | string | number, long = false): string {
  const then = new Date(value).getTime();
  const base = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(base)) return "";
  const minutes = Math.floor(Math.max(0, base - then) / 60_000);
  const unit = (count: number, short: string, word: string) => (long ? `${count} ${word}${count === 1 ? "" : "s"}` : `${count} ${short}`);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return unit(minutes, "min", "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "h", "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return unit(days, "d", "day");
  if (days < 365) return unit(Math.min(Math.floor(days / 30), 11), "mo", "month");
  return unit(Math.floor(days / 365), "y", "year");
}
