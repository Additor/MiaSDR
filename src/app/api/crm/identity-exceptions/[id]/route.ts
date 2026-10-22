import { z } from "zod";
import { ignoreIdentityException, resolveIdentityException } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/app/_lib/api";

const schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), personId: z.string().uuid() }),
  z.object({ status: z.literal("ignored") }),
]);

/** `resolved` files the quarantined message under the chosen person. `ignored` drops it. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/crm/identity-exceptions/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = schema.parse(await request.json());
    if (body.status === "ignored") {
      await ignoreIdentityException(crmDeps(), actor, id);
      return { ok: true };
    }
    return resolveIdentityException(crmDeps(), actor, id, { personId: body.personId });
  });
}
