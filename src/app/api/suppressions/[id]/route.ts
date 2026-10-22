import { removeSuppression } from "@/contexts/outreach/application/suppression-list";
import { suppressions } from "@/composition/inbox-filing";
import { withAdmin } from "@/app/_lib/api";

/** Removes an address added by hand. 409 for an unsubscribe, a complaint or a bounce, which stay on the list. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/suppressions/[id]">) {
  const { id } = await ctx.params;
  return withAdmin("Only an owner or admin can change the suppression list.", async (actor) => {
    await removeSuppression(suppressions(), actor, id);
    return { ok: true };
  });
}
