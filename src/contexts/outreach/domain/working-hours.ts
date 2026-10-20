export interface TimeWindow {
  /** HH:mm, 24-hour. */
  start: string;
  end: string;
}

export interface WorkingHours {
  timeZone: string;
  /** Keyed 0 (Sunday) to 6 (Saturday). A missing or empty day means no sending. An end at or before the start runs past midnight. */
  days: Record<string, TimeWindow[]>;
}

/** Monday to Friday, 09:00 to 18:00 in the given zone. */
export function defaultWorkingHours(timeZone: string): WorkingHours {
  const window = [{ start: "09:00", end: "18:00" }];
  return { timeZone, days: { "1": window, "2": window, "3": window, "4": window, "5": window } };
}

interface Zoned {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export { isValidTimeZone } from "@/shared/time-zone";

export function zonedParts(date: Date, timeZone: string): Zoned {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant the local calendar day containing `now` began in `timeZone`. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  let instant = midnightAsUtc - offsetMs(new Date(midnightAsUtc), timeZone);
  instant = midnightAsUtc - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinWorkingHours(now: Date, hours: WorkingHours): boolean {
  const p = zonedParts(now, hours.timeZone);
  const current = p.hour * 60 + p.minute;

  for (const window of hours.days[String(p.weekday)] ?? []) {
    const start = minutes(window.start);
    const end = minutes(window.end);
    if (end > start ? current >= start && current < end : current >= start) return true;
  }
  // An overnight window that began yesterday is still open until its end.
  for (const window of hours.days[String((p.weekday + 6) % 7)] ?? []) {
    const start = minutes(window.start);
    const end = minutes(window.end);
    if (end <= start && current < end) return true;
  }
  return false;
}
