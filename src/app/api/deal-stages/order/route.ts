import { reorderDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import { withAdmin } from "@/app/_lib/api";
import { idsSchema } from "@/app/api/deals/validation";

/** `{ ids }` names every stage once, in the new order. Open stays before Won, Won before Lost. */
export async function PUT(request: Request) {
  return withAdmin("Only an owner or admin can change pipeline stages.", async (actor) => reorderDealStages(dealsDeps(), actor, idsSchema.parse(await request.json()).ids));
}
