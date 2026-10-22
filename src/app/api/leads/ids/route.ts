import { listMatchingLeadIds } from "@/contexts/leads/application/lead-management";
import { MAX_MATCHING_IDS, parseLeadFilter } from "@/contexts/leads/domain/lead-filter";
import { leadDeps } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/**
 * The ids of every lead that matches the list filter params (the same ones as the export), up to MAX_MATCHING_IDS.
 * "Select all matching" on the lead list reads it, so a bulk action reaches leads on other pages. `ids` is ignored.
 */
export function GET(request: Request) {
  return withActor((actor) => {
    const params = new URL(request.url).searchParams;
    const filter = parseLeadFilter((key) => params.get(key));
    filter.ids = undefined;
    return listMatchingLeadIds(leadDeps(), actor, filter, MAX_MATCHING_IDS);
  });
}
