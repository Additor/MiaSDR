import { createDefaultDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { withAdmin } from "@/app/_lib/api";

/** Settings > Pipeline stages, "Create default stages": writes the defaults for an organization without stages. */
export async function POST() {
  return withAdmin("Only an owner or admin can change pipeline stages.", (actor) => createDefaultDealStages(dealsDeps(), actor));
}
