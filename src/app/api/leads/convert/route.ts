import { createDealsFromLeads } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/app/_lib/api";
import { bulkConvertSchema } from "@/app/api/deals/validation";

/** Create deals for many leads, one transaction each: `{ created: [{ personId, dealId }], skipped: [{ personId, reason }] }`. */
export async function POST(request: Request) {
  return withActor(async (actor) => {
    const { ids, ...input } = bulkConvertSchema.parse(await request.json());
    return createDealsFromLeads(dealsDeps(), actor, ids, input);
  });
}
