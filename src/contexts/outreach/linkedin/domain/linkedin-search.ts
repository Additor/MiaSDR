// Pure rules of the LinkedIn search queue: URL validation, status moves, limits, retry pacing. No I/O.

export type SearchStatus = "queued" | "running" | "paused" | "paused_limit" | "completed" | "failed" | "cancelled";
export type SearchAction = "pause" | "resume" | "cancel";

export const DEFAULT_MAX_RESULTS = 100;
export const MAX_SEARCH_RESULTS = 2500;
/** A claim holds the search and its account this long. A crashed worker's claim expires on its own. */
export const SEARCH_LEASE_SECONDS = 120;
/** Consecutive unknown outcomes (timeout, 5xx) before the search fails. */
export const MAX_SEARCH_FAILURES = 5;
/** Provider hard stop: no run of pages may exceed this many, whatever the provider says. */
export const MAX_SEARCH_PAGES = 400;

export type SearchVariant = "classic" | "sales_navigator";

export interface SearchUrl {
  url: string;
  variant: SearchVariant;
}

export type SearchUrlResult = { ok: true; value: SearchUrl } | { ok: false; reason: string };

/** Query parameters that only track where a link came from. Dropping them lets the same search compare equal. */
const TRACKING = new Set(["origin", "sid", "sessionid", "trk", "lipi", "lici", "midtoken", "midsig", "trkeml", "eid", "refid"]);

/**
 * Accepts a copied LinkedIn people search (`/search/results/people/`) or Sales Navigator people search
 * (`/sales/search/people`). Anything else, such as a profile or a company search, is refused with a reason.
 */
export function normalizeSearchUrl(input: string): SearchUrlResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "Paste a LinkedIn search URL." };
  if (text.length > 4000) return { ok: false, reason: "The URL is too long." };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return { ok: false, reason: "Use a linkedin.com search URL." };
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  let variant: SearchVariant;
  if (path === "/search/results/people") variant = "classic";
  else if (path === "/sales/search/people") variant = "sales_navigator";
  else {
    return { ok: false, reason: "Use a people search: open LinkedIn or Sales Navigator, search for people, and copy the URL from the browser address bar." };
  }
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (!TRACKING.has(key.toLowerCase())) kept.append(key, value);
  const query = kept.toString();
  const base = variant === "classic" ? "https://www.linkedin.com/search/results/people/" : "https://www.linkedin.com/sales/search/people";
  return { ok: true, value: { url: query ? `${base}?${query}` : base, variant } };
}

export function clampMaxResults(input: number | undefined): number | null {
  if (input === undefined) return DEFAULT_MAX_RESULTS;
  return Number.isInteger(input) && input >= 1 && input <= MAX_SEARCH_RESULTS ? input : null;
}

const FROM: Record<SearchAction, SearchStatus[]> = {
  pause: ["queued", "running", "paused_limit"],
  resume: ["paused", "paused_limit", "failed"],
  cancel: ["queued", "running", "paused", "paused_limit", "failed"],
};

export function canApply(status: SearchStatus, action: SearchAction): boolean {
  return FROM[action].includes(status);
}

export interface SearchActionButton {
  action: SearchAction;
  label: string;
}

const ACTION_ORDER: SearchAction[] = ["pause", "resume", "cancel"];

/**
 * The buttons a search row offers. Each one is an action `canApply` accepts for the status.
 * A search waiting for the daily limit offers Pause and Stop only: Resume would queue it again
 * and the next claim would pause it for the same limit. A failed search offers Retry only: it
 * already stopped, so Stop adds nothing (the server still accepts it).
 */
export function searchActions(status: SearchStatus): SearchActionButton[] {
  return ACTION_ORDER.filter((action) => canApply(status, action) && !(action === "resume" && status === "paused_limit") && !(action === "cancel" && status === "failed")).map((action) => ({
    action,
    label: action === "pause" ? "Pause" : action === "cancel" ? "Stop" : status === "failed" ? "Retry" : "Resume",
  }));
}

/** Everything a batch row can do. `run` makes the search due now, `rerun` queues a failed one again, `remove` takes it out of the batch. */
export type BatchRowActionId = SearchAction | "run" | "rerun" | "remove";

export interface BatchRowAction {
  id: BatchRowActionId;
  label: string;
}

export interface BatchRowActions {
  /** At most two buttons, the ones a person most likely wants for this status. */
  buttons: BatchRowAction[];
  /** The rest, in order. Stop and Remove come last, so a destructive item never sits first. */
  menu: BatchRowAction[];
}

const ROW_LABEL: Record<BatchRowActionId, string> = { pause: "Pause", resume: "Resume", cancel: "Stop", run: "Run", rerun: "Rerun", remove: "Remove" };
const rowAction = (id: BatchRowActionId): BatchRowAction => ({ id, label: ROW_LABEL[id] });

/**
 * Status to actions for a row of a search batch. Pure: the page only draws the result.
 * - queued: Run, Pause. running: Pause. paused: Run, with Resume in the menu (Run also skips the wait).
 * - waiting for the limit: Pause only, because Run cannot beat a limit. failed: Rerun, no Stop.
 * - done or stopped: nothing to start, only Remove.
 * `canRemove` is false for a member who did not create the batch.
 */
export function batchRowActions(status: SearchStatus, options: { canRemove: boolean }): BatchRowActions {
  const buttons: BatchRowActionId[] = [];
  const menu: BatchRowActionId[] = [];
  switch (status) {
    case "queued":
      buttons.push("run", "pause");
      menu.push("cancel");
      break;
    case "running":
      buttons.push("pause");
      menu.push("cancel");
      break;
    case "paused":
      buttons.push("run");
      menu.push("resume", "cancel");
      break;
    case "paused_limit":
      buttons.push("pause");
      menu.push("cancel");
      break;
    case "failed":
      buttons.push("rerun");
      break;
    case "completed":
    case "cancelled":
      break;
  }
  if (options.canRemove) menu.push("remove");
  return { buttons: buttons.map(rowAction), menu: menu.map(rowAction) };
}

/** A search the queue still works on or waits to work on. The lists refresh themselves while one exists. */
export const isActiveStatus = (status: string): boolean => status === "queued" || status === "running" || status === "paused_limit";

/** True when any status of a list, or any status with a positive count in a summary, is active. */
export function hasActiveSearch(statuses: readonly string[] | Readonly<Record<string, number>>): boolean {
  if (Array.isArray(statuses)) return statuses.some(isActiveStatus);
  return Object.entries(statuses as Record<string, number>).some(([status, count]) => count > 0 && isActiveStatus(status));
}

/** The status word a row shows. `paused_limit` is its own state, so it must not read as a paused search. */
export const searchStatusLabel = (status: SearchStatus): string => (status === "paused_limit" ? "waiting for limit" : status);

/**
 * The note under a row's status sentence. A search waiting for the limit stores the same sentence as `lastError`,
 * and `describeSearch` already says it, so the stored copy is dropped for that status.
 */
export function searchNotice(input: { status: SearchStatus; lastError: string | null }): string | null {
  return input.status === "paused_limit" ? null : input.lastError;
}

export const allowedFrom = (action: SearchAction): SearchStatus[] => FROM[action];

export const isFinished = (status: SearchStatus) => status === "completed" || status === "cancelled";

/** Resume restarts from the stored cursor, except a failed search, which a person retries on purpose. */
export function statusAfter(action: SearchAction): SearchStatus {
  return action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled";
}

/** How many of a page's items still fit under the cap. */
export function itemsToKeep(input: { pageSize: number; maxResults: number; alreadyFound: number }): number {
  return Math.max(0, Math.min(input.pageSize, input.maxResults - input.alreadyFound));
}

/** People an account may still read today. */
export function searchQuotaLeft(input: { limit: number; usedToday: number }): number {
  return Math.max(0, input.limit - input.usedToday);
}

/** The UTC day key that `search_leads_today` belongs to. */
export const searchDay = (now: Date) => now.toISOString().slice(0, 10);

/** Backoff after a provider outage: 1 minute, doubling, at most 15 minutes. */
export function searchRetrySeconds(failures: number): number {
  return Math.min(15 * 60, 60 * 2 ** Math.max(0, failures - 1));
}

export interface SearchProgressInput {
  status: SearchStatus;
  found: number;
  maxResults: number;
  pagesFetched: number;
  /** When search capacity returns, as printed text (see `formatCapacityReturn`). Null or missing when unknown. */
  capacityReturns?: string | null;
}

export interface SearchProgress {
  label: string;
  detail: string;
}

/** A status as one short label and a sentence for the table. */
export function describeSearch(input: SearchProgressInput): SearchProgress {
  const { status, found, maxResults, pagesFetched, capacityReturns } = input;
  switch (status) {
    case "queued":
      return { label: "Queued", detail: pagesFetched === 0 ? "Waiting for a free LinkedIn account." : `${found.toLocaleString("en-US")} found so far. Continues from the last page.` };
    case "running":
      return { label: "Running", detail: `${found.toLocaleString("en-US")} of up to ${maxResults.toLocaleString("en-US")} found.` };
    case "paused":
      return { label: "Paused", detail: "Resume to continue from the last page." };
    case "paused_limit":
      return {
        label: "Waiting for limit",
        detail: capacityReturns
          ? `Every connected account has used its daily search limit. The search continues when capacity returns: ${capacityReturns}.`
          : "Every connected account has used its daily search limit. The search continues when an account has capacity again.",
      };
    case "completed":
      return { label: "Done", detail: `${found.toLocaleString("en-US")} found.` };
    case "failed":
      return { label: "Failed", detail: "Retry to continue from the last page." };
    case "cancelled":
      return { label: "Cancelled", detail: "Stopped. People already found stay in Leads." };
  }
}

/** A provider member id (`ACoAA...`, `ACwAA...`), which a search may return when a person has no public slug. It is not a profile slug. */
const MEMBER_ID = /^AC[ow][A-Za-z0-9_-]{16,}$/;

/**
 * The public profile slug of a search result, or null when it only has a member id or a Sales Navigator link.
 * A result without a slug cannot be matched to a lead, so it is stored but not imported.
 */
export function resultSlug(item: { identifier: string; profileUrl: string | null }): string | null {
  for (const candidate of [item.profileUrl, item.identifier]) {
    if (!candidate) continue;
    const text = candidate.trim();
    const fromUrl = text.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (fromUrl) {
      // A classic search result links to /in/<member id> when the person has no public slug. That id is case sensitive and no slug.
      const path = safeDecode(fromUrl[1]);
      if (MEMBER_ID.test(path)) continue;
      return path.toLowerCase();
    }
    if (/^[\w%.-]+$/.test(text) && !MEMBER_ID.test(text)) return safeDecode(text).toLowerCase();
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
