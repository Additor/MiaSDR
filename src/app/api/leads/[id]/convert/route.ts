import { NextResponse } from "next/server";
import { createDealFromLead } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/app/_lib/api";
import { dealFieldsSchema } from "@/app/api/deals/validation";

/**
 * Create deal from a lead: the lead becomes a contact and gets its first deal, in one transaction. 201 with
 * `{ dealId, stopped, replayed: false }`; a repeat with the same `idempotencyKey` answers 200 with the first result.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/leads/[id]/convert">) {
  const { id } = await ctx.params;
  let replayed = false;
  const response = await withActor(async (actor) => {
    const result = await createDealFromLead(dealsDeps(), actor, id, dealFieldsSchema.parse(await request.json()));
    replayed = result.replayed;
    return result;
  }, 201);
  return replayed ? NextResponse.json(await response.json(), { status: 200 }) : response;
}
