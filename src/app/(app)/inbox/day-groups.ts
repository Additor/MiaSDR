import { DAY_GROUP_LABEL, type DayGroup } from "@/contexts/conversations/domain/inbox-filter";
import { formatDate, formatDateTime } from "@/shared/format-time";

const DAY_MS = 86_400_000;

/** Whole calendar days from `earlier` to `later`, both "YYYY-MM-DD". */
function daysBetween(earlier: string, later: string): number {
  const [y1, m1, d1] = earlier.split("-").map(Number);
  const [y2, m2, d2] = later.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/**
 * The list's day group for a message, counted in the organization's time zone so "Today" matches the clock times in the
 * rows. Same buckets as the domain's UTC `dayGroupOf`: "This week" covers the six days before yesterday.
 */
export function dayGroupInZone(date: Date, now: Date, timeZone: string): DayGroup {
  const day = formatDate(date, timeZone);
  const today = formatDate(now, timeZone);
  if (!day || !today) return "earlier";
  const age = daysBetween(day, today);
  if (age <= 0) return "today";
  if (age === 1) return "yesterday";
  if (age <= 7) return "week";
  return "earlier";
}

/** Splits rows that arrive newest first into labeled groups, keeping order and omitting empty groups. */
export function groupByDayInZone<T>(rows: T[], at: (row: T) => Date, now: Date, timeZone: string): Array<{ group: DayGroup; label: string; rows: T[] }> {
  const out: Array<{ group: DayGroup; label: string; rows: T[] }> = [];
  for (const row of rows) {
    const group = dayGroupInZone(at(row), now, timeZone);
    const last = out.at(-1);
    if (last && last.group === group) last.rows.push(row);
    else out.push({ group, label: DAY_GROUP_LABEL[group], rows: [row] });
  }
  return out;
}

/**
 * The time a row shows under its day divider. Today and Yesterday already say the day, so the row says the clock time ("14:05");
 * older groups say the date ("2026-10-12"), because the clock time of last week is not what finds a conversation.
 */
export function rowTimeLabel(date: Date, group: DayGroup, timeZone: string): string {
  return group === "today" || group === "yesterday" ? formatDateTime(date, timeZone).slice(11) : formatDate(date, timeZone);
}
