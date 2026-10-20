import type { Actor } from "@/shared/errors";
import { formatCapacityReturn, nextCapacityReturn, nextSearchDayStart, searchCapacity, type SearchCapacity } from "../domain/linkedin-search-capacity";
import type { LinkedInSearchCapacityDeps } from "./linkedin-search-ports";

export interface AccountSearchCapacity extends SearchCapacity {
  id: string;
  name: string;
}

export interface SearchCapacityView {
  accounts: AccountSearchCapacity[];
  /** When no listed account can search now: the earliest time one can, as a date and as printed text. */
  nextReturnAt: Date | null;
  nextReturnText: string | null;
  /** When every account's daily count restarts (the next 00:00 UTC). The page prints it in the organization's zone. */
  dayResetsAt: Date;
}

/**
 * The daily search allowance of each connected account. `accountIds` narrows the list to the accounts a batch may use;
 * empty means every connected account of the organization.
 */
export async function getSearchCapacity(deps: LinkedInSearchCapacityDeps, actor: Actor, accountIds: string[] = []): Promise<SearchCapacityView> {
  const now = (deps.now ?? (() => new Date()))();
  const { limit, accounts } = await deps.capacity.usage(actor.organizationId, accountIds);
  const rows = accounts.map((a) => ({ id: a.id, name: a.name, ...searchCapacity({ limit, usedToday: a.usedToday, usedDay: a.usedDay, limitReachedUntil: a.limitReachedUntil, now }) }));
  const nextReturnAt = nextCapacityReturn(rows);
  return { accounts: rows, nextReturnAt, nextReturnText: nextReturnAt ? formatCapacityReturn(nextReturnAt) : null, dayResetsAt: nextSearchDayStart(now) };
}
