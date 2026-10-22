import { createDefaultDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { withActor } from "@/app/_lib/api";

/** Settings > Pipeline stages, "Create default stages": writes the defaults for an organization without stages. */
export async function POST() {
  return withActor((actor) => createDefaultDealStages(dealsDeps(), actor));
}
