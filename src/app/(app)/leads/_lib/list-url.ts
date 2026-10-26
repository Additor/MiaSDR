import { leadFilterParams, type LeadFilter, type LeadSort } from "@/contexts/people/domain/lead-filter";

/** The URL of the people list for a filter, sort, page and page size. Defaults stay out of the URL. */
export function leadsHref(state: { filter: LeadFilter; sort: LeadSort; page?: number; size?: number }): string {
  const params = leadFilterParams({ ...state.filter, ids: undefined });
  if (state.sort.key !== "created" || state.sort.dir !== "desc") {
    params.set("sort", state.sort.key);
    params.set("dir", state.sort.dir);
  }
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.size && state.size !== 50) params.set("size", String(state.size));
  const qs = params.toString();
  return qs ? `/leads?${qs}` : "/leads";
}
