/** URL state of the Pipeline board. The old reply-board params (`category`, `channel`, `closed`) are not read, so they drop off. */
export interface BoardUrlState {
  owner?: string;
  q?: string;
  showAll?: boolean;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseBoardUrl(params: Record<string, string | string[] | undefined>): BoardUrlState {
  const owner = first(params.owner)?.trim() || undefined;
  const q = first(params.q)?.trim().slice(0, 200) || undefined;
  return { owner, q, showAll: first(params.showAll) === "1" };
}

export function boardHref(state: BoardUrlState): string {
  const params = new URLSearchParams();
  if (state.owner) params.set("owner", state.owner);
  if (state.q) params.set("q", state.q);
  if (state.showAll) params.set("showAll", "1");
  const qs = params.toString();
  return qs ? `/crm/pipeline?${qs}` : "/crm/pipeline";
}
