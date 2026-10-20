import { listContactIds } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/shared/api";

/**
 * "Select all matching" on Contacts: the ids of the contacts that match the list's `q`, `owner` and `stage`, newest conversion
 * first, up to 5,000. `{ ids, total, capped }`.
 */
export function GET(request: Request) {
  return withActor((actor) => {
    const { q, owner, stage } = Object.fromEntries(new URL(request.url).searchParams);
    return listContactIds(dealsDeps(), actor, { q, owner, stage });
  });
}
