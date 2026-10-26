/**
 * Inbox list parameters: views, filters, date ranges and the automated-mail rules. Pure, so the page, the
 * application layer and the SQL share one definition. A date filter reads its days in the organization's time zone, the
 * zone the list's day dividers and clock times use. Without a zone the days are UTC.
 */
import { calendarDayInZone, shiftDay, startOfDayInZone } from "@/shared/time-zone";


export const INBOX_VIEWS = ["all", "unread", "important", "sent", "replied", "ooo", "automated", "scheduled"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const INBOX_GROUPS = ["customer", "interested", "not_interested", "other"] as const;
export const DATE_MODES = ["all", "today", "yesterday", "custom"] as const;
export type DateMode = (typeof DATE_MODES)[number];

export const OUT_OF_OFFICE_KEY = "out_of_office";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_TYPE_KEY = /^[a-z][a-z0-9_]*$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_VALUES = 20;
const DAY_MS = 86_400_000;

/**
 * Sender and subject patterns of machine mail. The sources stay inside the syntax both JavaScript and
 * Postgres (`~*`) read the same way: no lookarounds, no `\b`, no `\s`.
 */
export const AUTOMATED_SENDER_PATTERN = "(^|[^a-z0-9])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|dmarc[a-z0-9_-]*|bounces?)([^a-z0-9]|$)";
export const AUTOMATED_SUBJECT_PATTERN =
  "(^|[^a-z0-9])(dmarc|report domain|aggregate report|delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|failure notice|delivery failure)([^a-z0-9]|$)";

const SENDER_RE = new RegExp(AUTOMATED_SENDER_PATTERN, "i");
const SUBJECT_RE = new RegExp(AUTOMATED_SUBJECT_PATTERN, "i");

export interface AutomatedProbe {
  autoReply?: boolean;
  possibleBounce?: boolean;
  from?: string | null;
  subject?: string | null;
}

/** Header flags win; the sender and subject patterns catch DMARC reports and no-reply mail that carry no flag. */
export function isAutomatedMessage(probe: AutomatedProbe): boolean {
  if (probe.autoReply || probe.possibleBounce) return true;
  return SENDER_RE.test(probe.from ?? "") || SUBJECT_RE.test(probe.subject ?? "");
}

export interface DateRange {
  /** Inclusive. */
  start: Date | null;
  /** Exclusive. */
  end: Date | null;
}

function parseDay(value: string | undefined): Date | null {
  const m = value ? DAY.exec(value.trim()) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Reject 2026-02-31, which Date.UTC rolls into March.
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]) ? date : null;
}

const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Whole days in `timeZone`, end day included. "Today" is the day `now` falls on there. A day is as long as the zone makes
 * it: 23 or 25 hours across a clock change. A reversed range swaps its ends; a bad date is open on that side.
 */
export function resolveDateRange(input: { mode?: string; from?: string; to?: string }, now: Date, timeZone = "UTC"): DateRange {
  const dayRange = (first: string, last: string): DateRange => ({ start: startOfDayInZone(first, timeZone), end: startOfDayInZone(shiftDay(last, 1), timeZone) });
  if (input.mode === "today" || input.mode === "yesterday") {
    const today = calendarDayInZone(now, timeZone);
    const day = input.mode === "today" ? today : shiftDay(today, -1);
    return dayRange(day, day);
  }
  if (input.mode !== "custom") return { start: null, end: null };
  let from = parseDay(input.from) ? input.from!.trim() : null;
  let to = parseDay(input.to) ? input.to!.trim() : null;
  if (from && to && from > to) [from, to] = [to, from];
  return { start: from ? startOfDayInZone(from, timeZone) : null, end: to ? startOfDayInZone(shiftDay(to, 1), timeZone) : null };
}

export type DayGroup = "today" | "yesterday" | "week" | "earlier";
export const DAY_GROUP_LABEL: Record<DayGroup, string> = { today: "Today", yesterday: "Yesterday", week: "This week", earlier: "Earlier" };

/** "This week" covers the six days before yesterday. */
export function dayGroupOf(date: Date, now: Date): DayGroup {
  const today = startOfDay(now).getTime();
  const t = date.getTime();
  if (t >= today) return "today";
  if (t >= today - DAY_MS) return "yesterday";
  if (t >= today - 7 * DAY_MS) return "week";
  return "earlier";
}

/** Splits rows that arrive newest first into labeled groups, keeping order and omitting empty groups. */
export function groupByDay<T>(rows: T[], at: (row: T) => Date, now: Date): Array<{ group: DayGroup; label: string; rows: T[] }> {
  const out: Array<{ group: DayGroup; label: string; rows: T[] }> = [];
  for (const row of rows) {
    const group = dayGroupOf(at(row), now);
    const last = out.at(-1);
    if (last && last.group === group) last.rows.push(row);
    else out.push({ group, label: DAY_GROUP_LABEL[group], rows: [row] });
  }
  return out;
}

type Raw = Record<string, string | string[] | undefined>;

const all = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

export interface InboxParams {
  view: InboxView;
  query: string;
  page: number;
  leadIds: string[];
  leadQuery: string;
  campaignIds: string[];
  mailboxIds: string[];
  replyTypeKeys: string[];
  groupKeys: string[];
  dateMode: DateMode;
  dateFrom: string;
  dateTo: string;
}

/** Reads the URL. Unknown values drop out instead of failing the page, so an old link still opens. */
export function parseInboxParams(raw: Raw): InboxParams {
  const one = (key: string) => all(raw[key])[0] ?? "";
  const lead = all(raw.lead);
  const dateFrom = parseDay(one("from")) ? one("from") : "";
  const dateTo = parseDay(one("to")) ? one("to") : "";
  // Typing a date without touching the range select still means a custom range.
  const picked = DATE_MODES.find((m) => m === one("range")) ?? "all";
  const dateMode: DateMode = picked === "all" && (dateFrom || dateTo) ? "custom" : picked;
  return {
    view: INBOX_VIEWS.find((v) => v === one("view")) ?? "all",
    query: (Array.isArray(raw.q) ? raw.q[0] : raw.q)?.trim().slice(0, 200) ?? "",
    page: Math.max(1, Math.floor(Number(one("page"))) || 1),
    leadIds: lead.filter((v) => UUID.test(v)).slice(0, MAX_VALUES),
    leadQuery: (lead.find((v) => !UUID.test(v)) ?? "").slice(0, 200),
    campaignIds: all(raw.campaign).filter((v) => UUID.test(v)).slice(0, MAX_VALUES),
    mailboxIds: all(raw.mailbox).filter((v) => UUID.test(v)).slice(0, MAX_VALUES),
    replyTypeKeys: all(raw.subcategory).filter((v) => REPLY_TYPE_KEY.test(v)).slice(0, MAX_VALUES),
    groupKeys: all(raw.category).filter((v): v is (typeof INBOX_GROUPS)[number] => (INBOX_GROUPS as readonly string[]).includes(v)),
    dateMode,
    dateFrom,
    dateTo,
  };
}

/** The query string for an inbox link. Defaults and empty values stay out so URLs stay short and comparable. */
export function inboxHref(params: Partial<InboxParams>, override: Partial<InboxParams> = {}): string {
  const p = { ...params, ...override };
  const qs = new URLSearchParams();
  if (p.query) qs.set("q", p.query);
  if (p.view && p.view !== "all") qs.set("view", p.view);
  for (const id of p.leadIds ?? []) qs.append("lead", id);
  if (p.leadQuery) qs.append("lead", p.leadQuery);
  for (const id of p.campaignIds ?? []) qs.append("campaign", id);
  for (const id of p.mailboxIds ?? []) qs.append("mailbox", id);
  for (const k of p.replyTypeKeys ?? []) qs.append("subcategory", k);
  for (const k of p.groupKeys ?? []) qs.append("category", k);
  if (p.dateMode && p.dateMode !== "all") {
    qs.set("range", p.dateMode);
    if (p.dateMode === "custom") {
      if (p.dateFrom) qs.set("from", p.dateFrom);
      if (p.dateTo) qs.set("to", p.dateTo);
    }
  }
  if (p.page && p.page > 1) qs.set("page", String(p.page));
  const s = qs.toString();
  return s ? `/inbox?${s}` : "/inbox";
}

/** Number of filters (not view or search) that narrow the list. */
export function activeFilterCount(p: InboxParams): number {
  return (
    Number(p.leadIds.length > 0 || p.leadQuery !== "") +
    Number(p.campaignIds.length > 0) +
    Number(p.mailboxIds.length > 0) +
    Number(p.replyTypeKeys.length > 0) +
    Number(p.groupKeys.length > 0) +
    Number(p.dateMode !== "all")
  );
}
