import { FormulaError } from "./formula-parser";

/**
 * Date helpers for the formula engine. Pure: the caller injects the clock and the time zone.
 *
 * A date value in a formula is ISO 8601 text. `2026-03-05` is a calendar date. `2026-03-05T14:30:00` is a wall
 * time in the organization zone. `2026-03-05T14:30:00Z` and `2026-03-05T14:30:00+09:00` are instants, which
 * resolve to the calendar date they fall on in the organization zone. Nothing else parses as a date.
 */

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isRealDate(year: number, month: number, day: number): boolean {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export const formatIsoDate = ({ year, month, day }: CivilDate): string => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** Days since 1970-01-01 of a proleptic Gregorian date. */
export function daysFromCivil({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch {
      throw new FormulaError(`"${timeZone}" is not a known time zone`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock of an instant in a zone. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute"), second: read("second") };
}

/** Today's calendar date in the zone. */
export const todayIn = (now: Date, timeZone: string): string => formatIsoDate(wallTimeIn(now, timeZone));

/** The current instant as ISO text with the zone's offset, to the second. */
export function nowIn(now: Date, timeZone: string): string {
  const wall = wallTimeIn(now, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = offsetMinutes === 0 ? "Z" : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${formatIsoDate(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${offset}`;
}

/** Calendar date of ISO text in the zone, or null when the text is not a real ISO 8601 date. */
export function parseIsoDate(text: string, timeZone: string): CivilDate | null {
  const m = ISO.exec(text.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isRealDate(year, month, day)) return null;
  if (m[4] === undefined) return { year, month, day };
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = m[7];
  if (zone === undefined) return { year, month, day };
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.replace(":", "");
    const hours = Number(digits.slice(1, 3));
    const minutes = Number(digits.slice(3, 5));
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (digits[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000);
  if (Number.isNaN(instant.getTime())) return null;
  const local = wallTimeIn(instant, timeZone);
  return isRealDate(local.year, local.month, local.day) ? { year: local.year, month: local.month, day: local.day } : null;
}

/**
 * Whole units from `start` to `end`. "D" counts days. "M" counts complete months: the count drops by one while the
 * end day of the month is before the start day, so 31 Jan to 28 Feb is 0 months. "Y" is "M" divided by 12, rounded
 * toward zero. The result is negative when `end` is before `start`, and swapping the dates flips the sign.
 */
export function dateDiff(start: CivilDate, end: CivilDate, unit: "D" | "M" | "Y"): number {
  if (unit === "D") return daysFromCivil(end) - daysFromCivil(start);
  const forward = daysFromCivil(end) >= daysFromCivil(start);
  const [a, b] = forward ? [start, end] : [end, start];
  let months = (b.year - a.year) * 12 + (b.month - a.month);
  if (b.day < a.day) months -= 1;
  const whole = unit === "M" ? months : Math.floor(months / 12);
  return forward ? whole : -whole;
}

export type DateFormat = Array<{ token: string } | { literal: string }>;

const DATE_TOKEN = /^(yyyy|yy|mmmm|mmm|mm|m|dd|d)/;

/** Date formats are built from yyyy yy mmmm mmm mm m dd d plus the separators space , - / . : Anything else is refused. */
export function parseDateFormat(format: string): DateFormat | null {
  const out: DateFormat = [];
  let i = 0;
  const lower = format.toLowerCase();
  while (i < format.length) {
    const rest = lower.slice(i);
    const m = DATE_TOKEN.exec(rest);
    if (m) {
      out.push({ token: m[1] });
      i += m[1].length;
    } else if (/^[ ,\-/.:]$/.test(format[i])) {
      out.push({ literal: format[i] });
      i += 1;
    } else {
      return null;
    }
  }
  return out.some((p) => "token" in p) ? out : null;
}

export function formatDate(date: CivilDate, format: DateFormat): string {
  return format
    .map((part) => {
      if ("literal" in part) return part.literal;
      switch (part.token) {
        case "yyyy":
          return pad(date.year, 4);
        case "yy":
          return pad(date.year % 100);
        case "mmmm":
          return MONTH_NAMES[date.month - 1];
        case "mmm":
          return MONTH_NAMES[date.month - 1].slice(0, 3);
        case "mm":
          return pad(date.month);
        case "m":
          return String(date.month);
        case "dd":
          return pad(date.day);
        default:
          return String(date.day);
      }
    })
    .join("");
}

const NUMBER_FORMAT = /^(#,##)?0(?:\.(0{1,10}))?$/;

/** Number formats: 0, 0.00, #,##0, #,##0.00 (any number of decimals up to 10). Null when the format is not one of these. */
export function formatNumber(value: number, format: string): string | null {
  const m = NUMBER_FORMAT.exec(format);
  if (!m) return null;
  const decimals = m[2]?.length ?? 0;
  // toFixed rounds half away from zero on the decimal text, which matches what a spreadsheet shows.
  const fixed = Math.abs(value) < 1e21 ? Number(`${Math.abs(value)}e${decimals}`) : NaN;
  const rounded = Number.isFinite(fixed) ? Math.round(fixed) / 10 ** decimals : Math.abs(value);
  let text = rounded.toFixed(decimals);
  if (m[1]) {
    const [int, frac] = text.split(".");
    text = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac !== undefined ? `.${frac}` : "");
  }
  return value < 0 && Number(text.replace(/,/g, "")) !== 0 ? `-${text}` : text;
}
