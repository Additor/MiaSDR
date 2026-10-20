/**
 * Status filters, page sizes and URL parameters of the campaign lead tables (email and LinkedIn). The filters use the lead
 * status vocabulary scoped to the campaign (`campaign-lead-status.ts`), plus All and Removed.
 */
import { campaignLeadState } from "./campaign-lead-status";
import { LEAD_STATE_LABELS, type LeadState } from "./lead-status";

export const ENROLLMENT_TABS = ["all", "queued", "in_sequence", "paused", "replied", "finished", "stopped", "removed"] as const;
export type EnrollmentTab = (typeof ENROLLMENT_TABS)[number];
type StateTab = Exclude<EnrollmentTab, "all" | "removed"> & LeadState;

export const ENROLLMENT_TAB_LABELS: Record<EnrollmentTab, string> = {
  all: "All",
  queued: LEAD_STATE_LABELS.queued,
  in_sequence: LEAD_STATE_LABELS.in_sequence,
  paused: LEAD_STATE_LABELS.paused,
  replied: LEAD_STATE_LABELS.replied,
  finished: LEAD_STATE_LABELS.finished,
  stopped: LEAD_STATE_LABELS.stopped,
  removed: "Removed",
};

/**
 * Enrollment statuses a filter can cover, whatever the campaign status. Queued and In sequence need an active campaign and
 * Paused needs one that is not, so `pending` and `active` sit under two filters here; `statusesForTab` with the campaign
 * status keeps the one that applies. `all` has no list: it is every filter but `removed`.
 */
export const TAB_STATUSES: Record<Exclude<EnrollmentTab, "all">, readonly string[]> = {
  queued: ["pending"],
  in_sequence: ["active"],
  paused: ["pending", "active"],
  replied: ["replied"],
  finished: ["completed"],
  stopped: ["bounced", "suppressed", "failed", "cancelled"],
  removed: ["removed"],
};

/** Filter values older links carry (`?status=pending`), read as the filter that took their place. */
const LEGACY_TABS: Record<string, EnrollmentTab> = { pending: "queued", completed: "finished", bounced: "stopped" };

/** A filter from a URL value, the older values included, or null when it names none. */
export const enrollmentTabOf = (value: string | undefined): EnrollmentTab | null =>
  value === undefined ? null : (ENROLLMENT_TABS.find((t) => t === value) ?? LEGACY_TABS[value] ?? null);

const isStateTab = (tab: EnrollmentTab): tab is StateTab => tab !== "all" && tab !== "removed";

/**
 * The filter an enrollment sits under in a campaign with this status, or null for a status the schema does not know.
 * Without a campaign status it answers by enrollment status alone (`pending` reads as Queued, `active` as In sequence).
 */
export function tabOfStatus(status: string, campaignStatus = "active"): Exclude<EnrollmentTab, "all"> | null {
  if (status === "removed") return "removed";
  return campaignLeadState(status, campaignStatus) as StateTab | null;
}

/**
 * Statuses a filter selects. With the campaign status, a filter that cannot apply selects nothing (Paused in an active
 * campaign). `all` is every status but removed.
 */
export function statusesForTab(tab: EnrollmentTab, campaignStatus?: string): readonly string[] {
  if (tab === "all") return [...new Set(Object.entries(TAB_STATUSES).filter(([t]) => t !== "removed").flatMap(([, s]) => s))];
  if (campaignStatus === undefined || !isStateTab(tab)) return TAB_STATUSES[tab];
  return TAB_STATUSES[tab].filter((status) => campaignLeadState(status, campaignStatus) === tab);
}

export type TabCounts = Record<EnrollmentTab, number>;

/**
 * Folds per-status counts of the whole campaign into per-filter counts. With the campaign status each status counts under
 * the one filter it reads as; without it, `pending` and `active` count under Paused too. Unknown statuses count nowhere.
 */
export function countsByTab(statusCounts: ReadonlyArray<{ status: string; n: number }>, campaignStatus?: string): TabCounts {
  const counts = Object.fromEntries(ENROLLMENT_TABS.map((t) => [t, 0])) as TabCounts;
  for (const { status, n } of statusCounts) {
    const tabs = (Object.keys(TAB_STATUSES) as Array<Exclude<EnrollmentTab, "all">>).filter((tab) => statusesForTab(tab, campaignStatus).includes(status));
    if (tabs.length === 0) continue;
    for (const tab of tabs) counts[tab] += n;
    if (status !== "removed") counts.all += n;
  }
  return counts;
}

/**
 * The filters a campaign's lead table offers, in order. An active campaign offers Queued and In sequence, any other
 * Paused. Removed shows once a lead was removed. The current filter always shows, so the active chip never disappears.
 */
export function campaignLeadTabs(campaignStatus: string, counts: TabCounts, current: EnrollmentTab): EnrollmentTab[] {
  const running = campaignStatus === "active";
  return ENROLLMENT_TABS.filter((tab) => {
    if (tab === current) return true;
    if (tab === "removed") return counts.removed > 0;
    if (tab === "queued" || tab === "in_sequence") return running;
    if (tab === "paused") return !running;
    return true;
  });
}

export const ENROLLMENT_PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_ENROLLMENT_PAGE_SIZE = 50;
export const MAX_ENROLLMENT_SEARCH = 100;

export interface EnrollmentListQuery {
  tab: EnrollmentTab;
  /**
   * The campaign's status, set by the use case after it loads the campaign, so a filter selects the statuses that read as
   * its state there. Never read from the URL.
   */
  campaignStatus?: string;
  /** Trimmed search text, empty when none. */
  search: string;
  page: number;
  pageSize: number;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Reads `tab`, `q`, `size` and `page` from URL parameters. Older filter values map to their successor; anything unknown falls back to the default. */
export function parseEnrollmentListQuery(params: Record<string, string | string[] | undefined>): EnrollmentListQuery {
  const tab = enrollmentTabOf(first(params.tab)) ?? "all";
  const size = Number(first(params.size));
  const pageSize = ENROLLMENT_PAGE_SIZES.find((s) => s === size) ?? DEFAULT_ENROLLMENT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(Number(first(params.page))) || 1);
  const search = (first(params.q) ?? "").trim().slice(0, MAX_ENROLLMENT_SEARCH);
  return { tab, search, page, pageSize };
}

/** Query string for the lead table. Defaults are left out so links stay short. */
export function enrollmentListHref(base: string, query: Partial<EnrollmentListQuery>): string {
  const params = new URLSearchParams();
  if (query.tab && query.tab !== "all") params.set("tab", query.tab);
  if (query.search) params.set("q", query.search);
  if (query.pageSize && query.pageSize !== DEFAULT_ENROLLMENT_PAGE_SIZE) params.set("size", String(query.pageSize));
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Identity of the rows a lead table shows. The selection provider takes it as its React key, so ticked
 * ids reset whenever the tab, search, page size or page changes and "Remove" never reaches a row
 * that is no longer on screen.
 */
export function enrollmentSelectionKey(campaignId: string, query: Partial<EnrollmentListQuery>): string {
  return enrollmentListHref(campaignId, query);
}

/**
 * Failed attempts of a send, for "Retries: n of 3". A send in flight or delivered on attempt k used k - 1 retries;
 * a failed one used all k attempts.
 */
export function retriesUsed(status: string, attempt: number): number {
  return status === "failed" ? Math.max(0, attempt) : Math.max(0, attempt - 1);
}
