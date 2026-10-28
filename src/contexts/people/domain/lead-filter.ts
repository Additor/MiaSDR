/*
 * The lead list filter, shared by the list page, the export, the ids route and the
 * bulk delete. The URL carries it as plain query params, so a filtered list can be
 * bookmarked and an export link reproduces what the screen shows.
 */

export interface LeadFilter {
  /** Free-text search over name, email, title, company, LinkedIn and phone. */
  query?: string;
  /** "any" is in at least one campaign, "none" in no campaign, a uuid in that campaign. */
  campaign?: string;
  /** A campaign the lead is not in. */
  notInCampaign?: string;
  hasEmail?: boolean;
  hasLinkedin?: boolean;
  doNotContact?: boolean;
  /**
   * True: the lead replied. False: it did not. A reply is an enrollment in a regular campaign with status `replied`, or an
   * inbound message in a public conversation of the person.
   */
  replied?: boolean;
  /** True: the person has a record with a public conversation (inbound or outbound). False: it has none. */
  hasConversation?: boolean;
  /** Who the list shows. Absent means `lead` (`DEFAULT_LIFECYCLE`); `all` is the only way to list both. */
  lifecycle?: LifecycleFilter;
  /** Inclusive UTC dates on the lead's last contact (latest sent message, any channel). A lead never contacted matches neither. */
  lastContactFrom?: string;
  lastContactTo?: string;
  /** The part of `people.source` before the first colon ("import", "grid", "manual"), or the whole value. */
  source?: string;
  /** Inclusive dates, YYYY-MM-DD, compared in UTC. */
  createdFrom?: string;
  createdTo?: string;
  /** Reply category key of any of the lead's reply records. */
  category?: string;
  /** Explicit selection. Used by the export of ticked rows. */
  ids?: string[];
}

/** A person's stage: a lead until converted, then a contact for good (`people_lifecycle_ck`, `people_lifecycle_trg`). */
export const LIFECYCLES = ["lead", "contact"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const LIFECYCLE_FILTERS = [...LIFECYCLES, "all"] as const;
export type LifecycleFilter = (typeof LIFECYCLE_FILTERS)[number];
/** What a filter without a `lifecycle` shows. Every reader of the filter applies it, so a bare `{}` never lists a contact. */
export const DEFAULT_LIFECYCLE: LifecycleFilter = "lead";

/** The lifecycle a filter lists once the default is applied. */
export function lifecycleOf(filter: LeadFilter): LifecycleFilter {
  return filter.lifecycle ?? DEFAULT_LIFECYCLE;
}

export const LEAD_SORT_KEYS = ["name", "company", "title", "email", "created"] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";
export interface LeadSort {
  key: LeadSortKey;
  dir: SortDirection;
}

export const DEFAULT_LEAD_SORT: LeadSort = { key: "created", dir: "desc" };
export const MAX_FILTER_IDS = 200;

/** The export route reads at most MAX_FILTER_IDS ids. Says which ids go and what the button must tell the person. */
export function selectionExport(selected: readonly string[]): { ids: string[]; capped: boolean; label: string } {
  const ids = selected.slice(0, MAX_FILTER_IDS);
  const capped = selected.length > MAX_FILTER_IDS;
  const label = capped ? `Export first ${MAX_FILTER_IDS} of ${selected.length.toLocaleString("en-US")}` : "Export selected";
  return { ids, capped, label };
}

/** The most ids "Select all matching" collects. It matches the bulk delete cap, and the campaign add sends them 500 at a time. */
export const MAX_MATCHING_IDS = 5000;

/**
 * What the selection bar offers after a person ticks rows. `canSelectAll` is true while more leads match than are ticked
 * and the cap allows more; `capped` is true when the filter matches more than the cap and the whole cap is already ticked.
 */
export function matchingSelection(selectedCount: number, total: number): { canSelectAll: boolean; capped: boolean; reach: number } {
  const reach = Math.min(total, MAX_MATCHING_IDS);
  return { canSelectAll: selectedCount < reach, capped: total > MAX_MATCHING_IDS && selectedCount >= MAX_MATCHING_IDS, reach };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[\w.-]{1,60}(:[\w.-]{1,100})?$/;
const CATEGORY = /^[a-z_]{1,40}$/;

type Read = (key: string) => string | null | undefined;

function validDate(value: string | null | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

function tristate(value: string | null | undefined): boolean | undefined {
  return value === "yes" ? true : value === "no" ? false : undefined;
}

/** Reads a filter from URL params. Values that do not parse are dropped, never guessed. */
export function parseLeadFilter(read: Read): LeadFilter {
  const filter: LeadFilter = {};
  const query = read("q")?.trim().slice(0, 100);
  if (query) filter.query = query;
  const campaign = read("campaign");
  if (campaign === "any" || campaign === "none" || (campaign && UUID.test(campaign))) filter.campaign = campaign.toLowerCase();
  const notIn = read("notCampaign");
  if (notIn && UUID.test(notIn)) filter.notInCampaign = notIn.toLowerCase();
  const hasEmail = tristate(read("email"));
  if (hasEmail !== undefined) filter.hasEmail = hasEmail;
  const hasLinkedin = tristate(read("linkedin"));
  if (hasLinkedin !== undefined) filter.hasLinkedin = hasLinkedin;
  const dnc = tristate(read("dnc"));
  if (dnc !== undefined) filter.doNotContact = dnc;
  const replied = tristate(read("replied"));
  if (replied !== undefined) filter.replied = replied;
  const hasConversation = tristate(read("hasConversation"));
  if (hasConversation !== undefined) filter.hasConversation = hasConversation;
  // The default stays out of the filter, so a parsed URL and its re-written params agree. An unknown value is dropped too.
  const lifecycle = LIFECYCLE_FILTERS.find((value) => value === read("lifecycle"));
  if (lifecycle && lifecycle !== DEFAULT_LIFECYCLE) filter.lifecycle = lifecycle;
  const lastFrom = validDate(read("lastFrom"));
  if (lastFrom) filter.lastContactFrom = lastFrom;
  const lastTo = validDate(read("lastTo"));
  if (lastTo) filter.lastContactTo = lastTo;
  const source = read("source");
  if (source && SOURCE.test(source)) filter.source = source;
  const from = validDate(read("from"));
  if (from) filter.createdFrom = from;
  const to = validDate(read("to"));
  if (to) filter.createdTo = to;
  const category = read("category");
  if (category && CATEGORY.test(category)) filter.category = category;
  const ids = (read("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID.test(id));
  if (ids.length > 0) filter.ids = [...new Set(ids)].slice(0, MAX_FILTER_IDS);
  return filter;
}

/**
 * True when the filter narrows the list. An empty filter selects everything, so bulk delete refuses it.
 * The default lifecycle is not a narrowing the person chose, so it does not count.
 */
export function isFilterActive(filter: LeadFilter): boolean {
  return (
    Boolean(filter.query?.trim()) ||
    filter.campaign !== undefined ||
    filter.notInCampaign !== undefined ||
    filter.hasEmail !== undefined ||
    filter.hasLinkedin !== undefined ||
    filter.doNotContact !== undefined ||
    filter.replied !== undefined ||
    filter.hasConversation !== undefined ||
    (filter.lifecycle !== undefined && filter.lifecycle !== DEFAULT_LIFECYCLE) ||
    filter.lastContactFrom !== undefined ||
    filter.lastContactTo !== undefined ||
    filter.source !== undefined ||
    filter.createdFrom !== undefined ||
    filter.createdTo !== undefined ||
    filter.category !== undefined ||
    (filter.ids?.length ?? 0) > 0
  );
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

/** The URL params of a filter, the inverse of `parseLeadFilter`. */
export function leadFilterParams(filter: LeadFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.query) params.set("q", filter.query);
  if (filter.campaign) params.set("campaign", filter.campaign);
  if (filter.notInCampaign) params.set("notCampaign", filter.notInCampaign);
  if (filter.hasEmail !== undefined) params.set("email", yesNo(filter.hasEmail));
  if (filter.hasLinkedin !== undefined) params.set("linkedin", yesNo(filter.hasLinkedin));
  if (filter.doNotContact !== undefined) params.set("dnc", yesNo(filter.doNotContact));
  if (filter.replied !== undefined) params.set("replied", yesNo(filter.replied));
  if (filter.hasConversation !== undefined) params.set("hasConversation", yesNo(filter.hasConversation));
  if (filter.lifecycle && filter.lifecycle !== DEFAULT_LIFECYCLE) params.set("lifecycle", filter.lifecycle);
  if (filter.lastContactFrom) params.set("lastFrom", filter.lastContactFrom);
  if (filter.lastContactTo) params.set("lastTo", filter.lastContactTo);
  if (filter.source) params.set("source", filter.source);
  if (filter.createdFrom) params.set("from", filter.createdFrom);
  if (filter.createdTo) params.set("to", filter.createdTo);
  if (filter.category) params.set("category", filter.category);
  if (filter.ids?.length) params.set("ids", filter.ids.join(","));
  return params;
}

export function parseLeadSort(key: string | null | undefined, dir: string | null | undefined): LeadSort {
  const sortKey = LEAD_SORT_KEYS.find((k) => k === key);
  if (!sortKey) return DEFAULT_LEAD_SORT;
  // Dates read newest first, text reads A to Z, until the person flips it.
  const fallback: SortDirection = sortKey === "created" ? "desc" : "asc";
  return { key: sortKey, dir: dir === "asc" || dir === "desc" ? dir : fallback };
}
