/** The queue filters that sit inside the "More filters" disclosure. */
export interface MoreFilterValues {
  subcategoryId: string;
  campaignId: string;
  dueAfter: string;
  dueBefore: string;
}

/** True when any rarely used filter is set, so the disclosure opens and the person sees why the queue is narrowed. */
export function hasMoreFilters(values: MoreFilterValues): boolean {
  return [values.subcategoryId, values.campaignId, values.dueAfter, values.dueBefore].some((v) => v !== "");
}

/** True when any queue filter narrows the list, so an empty queue can say "no match" instead of "nothing waiting". */
export function hasAnyFilter(values: MoreFilterValues & { category: string; channel: string; group: string; errorsOnly: boolean }): boolean {
  return hasMoreFilters(values) || values.category !== "" || values.channel !== "" || values.group !== "" || values.errorsOnly;
}
