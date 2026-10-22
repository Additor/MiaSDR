import { deleteDeal, getDeal, updateDeal } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { withActor } from "@/app/_lib/api";
import { ValidationError } from "@/shared/errors";
import { updateDealSchema } from "../validation";

export async function GET(_request: Request, ctx: RouteContext<"/api/deals/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getDeal(dealsDeps(), actor, id));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/deals/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => updateDeal(dealsDeps(), actor, id, updateDealSchema.parse(await request.json())));
}

/** Deletes an open deal. `?expectedVersion=` makes the delete refuse a deal that changed since it was read. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/deals/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const raw = new URL(request.url).searchParams.get("expectedVersion");
    const expectedVersion = raw === null ? undefined : Number(raw);
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) throw new ValidationError("Send the deal's current version.");
    await deleteDeal(dealsDeps(), actor, id, { expectedVersion });
    return { ok: true };
  });
}
