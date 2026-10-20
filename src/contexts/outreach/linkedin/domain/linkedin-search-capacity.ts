// Pure rules of the "Search capacity today" display: how much of its daily search allowance an account has left, and when it returns. No I/O.
import { searchDay, searchQuotaLeft } from "./linkedin-search";

export type CapacityTier = "green" | "yellow" | "red";

export interface CapacityInput {
  /** People one account may read per UTC day (`searchLeadsPerDay`). */
  limit: number;
  /** The stored counter, and the UTC day it belongs to. A counter from an earlier day counts as 0. */
  usedToday: number;
  usedDay: string | null;
  /** Set while LinkedIn's own limit pauses the account. */
  limitReachedUntil: Date | null;
  now: Date;
}

export interface SearchCapacity {
  limit: number;
  used: number;
  left: number;
  tier: CapacityTier;
  /** The account is paused by LinkedIn until this time. Null when it is not. */
  restrictedUntil: Date | null;
  /** When the account can search again. Null when it can search now. */
  returnsAt: Date | null;
}

/** Green above half the allowance, red below one eighth, yellow between. Exactly half and exactly one eighth are yellow. */
export function capacityTier(left: number, limit: number): CapacityTier {
  if (limit <= 0) return "red";
  if (left > limit / 2) return "green";
  if (left < limit / 8) return "red";
  return "yellow";
}

/** The next UTC midnight after `now`, when `search_day` rolls over and the counter starts at 0. */
export function nextSearchDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function searchCapacity(input: CapacityInput): SearchCapacity {
  const { limit, now } = input;
  const used = input.usedDay === searchDay(now) ? input.usedToday : 0;
  const left = searchQuotaLeft({ limit, usedToday: used });
  const restrictedUntil = input.limitReachedUntil && input.limitReachedUntil.getTime() > now.getTime() ? input.limitReachedUntil : null;
  const midnight = nextSearchDayStart(now);
  let returnsAt: Date | null = null;
  if (left === 0) returnsAt = restrictedUntil && restrictedUntil.getTime() > midnight.getTime() ? restrictedUntil : midnight;
  else if (restrictedUntil) returnsAt = restrictedUntil;
  return { limit, used, left, tier: restrictedUntil ? "red" : capacityTier(left, limit), restrictedUntil, returnsAt };
}

/** The earliest time a search can run again, or null when at least one of the accounts can search now. Null as well without accounts. */
export function nextCapacityReturn(capacities: SearchCapacity[]): Date | null {
  if (capacities.length === 0 || capacities.some((c) => c.returnsAt === null)) return null;
  return capacities.reduce((first, c) => (c.returnsAt && c.returnsAt.getTime() < first.getTime() ? c.returnsAt : first), capacities[0].returnsAt as Date);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 17 Oct, 00:00 UTC". Fixed zone and format, so the server and the browser print the same text. */
export function formatCapacityReturn(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** People the accounts can still read today. An account LinkedIn restricted counts as 0, because it cannot search before the restriction ends. */
export function searchableLeft(accounts: ReadonlyArray<{ left: number; restrictedUntil: Date | string | null }>): number {
  return accounts.reduce((sum, a) => sum + (a.restrictedUntil === null ? a.left : 0), 0);
}

/**
 * The line under an account whose capacity is low. `resetsAt` is the printed time (in the organization's zone) when the
 * daily count restarts. Null for accounts that are fine, and for restricted accounts, whose own line names the restriction.
 */
export function capacityNote(input: { tier: CapacityTier; left: number; restricted: boolean; resetsAt: string | null }): string | null {
  if (input.tier !== "red" || input.restricted || input.resetsAt === null) return null;
  if (input.left === 0) return `Resets at ${input.resetsAt}. New searches wait until then.`;
  return `Resets at ${input.resetsAt}. After ${input.left.toLocaleString("en-US")} more ${input.left === 1 ? "person" : "people"}, new searches wait until then.`;
}

export interface RunNowInput {
  /** Queued and paused searches that Run now makes due. */
  due: number;
  /** `searchableLeft` of the accounts the batch may use. */
  left: number;
  accounts: number;
  /** When the daily count restarts, as printed text in the organization's zone. */
  resetsAt: string;
}

/** Title and body of the Run now confirmation: what it may spend and what it leaves alone. */
export function runNowConfirmation(input: RunNowInput): { title: string; description: string } {
  const { due, left, accounts, resetsAt } = input;
  const searches = `${due.toLocaleString("en-US")} ${due === 1 ? "search" : "searches"}`;
  const untouched = "Running, finished and failed searches, and people already in Leads, stay as they are.";
  const spend =
    left > 0
      ? `They can read up to ${left.toLocaleString("en-US")} more ${left === 1 ? "person" : "people"} today across ${accounts.toLocaleString("en-US")} ${accounts === 1 ? "account" : "accounts"}. The rest wait until the count resets at ${resetsAt}.`
      : `No account has search capacity left today, so they start when it returns at ${resetsAt}.`;
  return { title: `Run ${searches} now?`, description: `Queued and paused searches skip their wait. ${spend} ${untouched}` };
}
