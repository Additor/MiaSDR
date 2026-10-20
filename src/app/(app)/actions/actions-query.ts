/** The query keys the Actions page reads besides `scope`. Everything else in a URL is ignored. */
export const ACTIONS_FILTER_KEYS = ["category", "channel", "group", "subcategoryId", "campaignId", "dueAfter", "dueBefore", "errorsOnly"] as const;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * The part of a URL that names a view of the queue: its scope and filters, empty values dropped. A row on Actions hands it to the
 * thread (`from=actions&...`), and the thread uses it for Back and for "Next in queue", so both land in the view the row came from.
 */
export function actionsViewFrom(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const view: Record<string, string> = {};
  for (const key of ["scope", ...ACTIONS_FILTER_KEYS]) {
    const value = first(params[key]);
    if (value !== "") view[key] = value;
  }
  return view;
}

/** `/actions` with the view's query string. */
export function actionsHref(view: Record<string, string>): string {
  const query = new URLSearchParams(view).toString();
  return query === "" ? "/actions" : `/actions?${query}`;
}

/** The thread's own query for a row opened from Actions: the view, and `from=actions` to say where it came from. */
export function threadQueryFromActions(view: Record<string, string>): string {
  return new URLSearchParams({ ...view, from: "actions" }).toString();
}
