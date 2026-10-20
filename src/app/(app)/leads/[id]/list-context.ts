import { DEFAULT_LEAD_SORT, leadFilterParams, parseLeadFilter, parseLeadSort, type LeadFilter, type LeadSort } from "@/contexts/leads/domain/lead-filter";

/*
 * The lead page remembers which list it was opened from. The list's row link adds `?list=<the list's query string>`;
 * the previous and next links of the lead page carry it on, and the back link returns to the same filtered, sorted
 * page. A lead opened without it (a campaign, the inbox, a pasted link) has no list context and shows no controls.
 */

export const LIST_PARAM = "list";
const MAX_LENGTH = 2000;

export interface ListContext {
  filter: LeadFilter;
  sort: LeadSort;
  /** The list's query string without the question mark, normalized: what `parseListContext` read, written back. */
  query: string;
}

/** The query string of a list URL such as "/leads?q=ada&sort=name", without the question mark. */
export function listQueryOf(listHref: string): string {
  const at = listHref.indexOf("?");
  return at === -1 ? "" : listHref.slice(at + 1);
}

/** The lead page URL from a list row. An empty or missing list query keeps the context (the unfiltered list) when `list` is a string. */
export function leadHref(id: string, listQuery?: string | null): string {
  return listQuery === undefined || listQuery === null ? `/leads/${id}` : `/leads/${id}?${LIST_PARAM}=${encodeURIComponent(listQuery)}`;
}

/**
 * Reads the `list` param. Returns null when it is absent or unusable, so the page hides the controls.
 * The filter and sort go through the list's own parsers: unknown or malformed values drop, never guess.
 */
export function parseListContext(raw: string | string[] | undefined): ListContext | null {
  if (typeof raw !== "string" || raw.length > MAX_LENGTH) return null;
  const params = new URLSearchParams(raw);
  const filter = parseLeadFilter((key) => params.get(key));
  const sort = parseLeadSort(params.get("sort"), params.get("dir"));
  // Keep the list's paging and sort params so the back link lands where the person was.
  const kept = leadFilterParams(filter);
  if (sort.key !== DEFAULT_LEAD_SORT.key || sort.dir !== DEFAULT_LEAD_SORT.dir) {
    kept.set("sort", sort.key);
    kept.set("dir", sort.dir);
  }
  for (const key of ["page", "size"]) {
    const value = params.get(key);
    if (value && /^\d{1,6}$/.test(value)) kept.set(key, value);
  }
  return { filter, sort, query: kept.toString() };
}

/** The list URL a lead page returns to. */
export function backToListHref(context: ListContext | null): string {
  return context && context.query ? `/leads?${context.query}` : "/leads";
}

/** The previous or next lead's URL. It carries the same list context, or none when there is no neighbor. */
export function neighborHref(neighborId: string | null, context: ListContext): string | null {
  return neighborId ? leadHref(neighborId, context.query) : null;
}
