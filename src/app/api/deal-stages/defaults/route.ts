import { createDefaultDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/shared/api";

/** Settings > Pipeline stages, "Create default stages": writes the defaults for an organization without stages. */
export async function POST() {
  return withActor((actor) => createDefaultDealStages(dealsDeps(), actor));
}
