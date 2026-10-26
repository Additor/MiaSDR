/**
 * A calendar day as the app writes it, yyyy-MM-dd, read and written in the browser's own calendar. Local midnight keeps
 * "2026-03-08" on March 8 in every time zone, where `new Date("2026-03-08")` reads UTC midnight and can land a day early.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day at local midnight, or null for anything that is not a real yyyy-MM-dd day (2026-02-30, "", "2026-3-8"). */
export function parseDay(text: string): Date | null {
  const match = DAY.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(2000, month - 1, day);
  date.setFullYear(year);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** The local calendar day of `date` as yyyy-MM-dd. */
export function formatDay(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
