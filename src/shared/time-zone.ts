/**
 * Browsers report time zones by ICU's ids, and ICU still uses a few old names ("Asia/Calcutta",
 * "Europe/Kiev") that tzdata keeps only as backward links. PostgreSQL resolves AT TIME ZONE against its own
 * tzdata, and builds without the backward links (Debian moved them to tzdata-legacy) reject those names.
 * Every zone is mapped to its current IANA name before it is stored or reaches SQL.
 */

/** ICU's legacy ids that differ from the current IANA name . */
export const LEGACY_ZONE_ALIASES: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/**
 * The current IANA name of a zone the runtime knows (case folded, legacy ids mapped), or null when the zone is
 * unknown. The result is safe to store and to hand to PostgreSQL.
 */
export function canonicalTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return LEGACY_ZONE_ALIASES[resolved] ?? resolved;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written YYYY-MM-DD. 2026-02-31 is not one. */
export function isCalendarDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

/** The calendar day `delta` days from `day` (YYYY-MM-DD). Calendar arithmetic, so a 23 or 25 hour day counts as one day. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The calendar day (YYYY-MM-DD) that `at` falls on in `zone`. */
export function calendarDayInZone(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function offsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant the calendar day `day` (YYYY-MM-DD) begins in `zone`. `day` must be a real day and `zone` a zone the runtime
 * knows; callers check both first. A day that starts in a gap (a zone that skips midnight) starts at the first valid instant.
 */
export function startOfDayInZone(day: string, zone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Two passes settle the offset across a daylight-saving change.
  let instant = wall - offsetMs(zone, new Date(wall));
  instant = wall - offsetMs(zone, new Date(instant));
  return new Date(instant);
}

/** True when `Intl` accepts the zone id. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
