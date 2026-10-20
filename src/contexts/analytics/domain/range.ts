/** Date ranges are whole calendar days (YYYY-MM-DD) in the organization's time zone, both ends inclusive. */

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

export interface DateRange {
  from: string;
  to: string;
}

export class AnalyticsInputError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, counting both ends. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDay(range: DateRange): string[] {
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * The range a request asks for. A missing `to` is today (in the organization's zone),
 * a missing `from` is `DEFAULT_RANGE_DAYS` days ending on `to`.
 */
export function resolveRange(input: { from?: string | null; to?: string | null }, today: string): DateRange {
  const to = input.to || today;
  const from = input.from || addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (!isValidDate(from) || !isValidDate(to)) throw new AnalyticsInputError("Dates must be written as YYYY-MM-DD.");
  if (from > to) throw new AnalyticsInputError("The start date is after the end date.");
  if (dayCount(from, to) > MAX_RANGE_DAYS) throw new AnalyticsInputError(`The range can span at most ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

export function parseOptionalId(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  if (!isUuid(value)) throw new AnalyticsInputError(`${label} is not a valid id.`);
  return value.toLowerCase();
}
