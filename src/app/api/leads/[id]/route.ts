import { BLOCK_MESSAGES, deleteLeads, getLead, updateLead } from "@/contexts/people/application/lead-management";
import { leadDeleteDeps } from "@/composition/person-lifecycle";
import { leadDeps } from "@/contexts/people/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { editSchema, leadId } from "../validation";

export async function GET(_request: Request, ctx: RouteContext<"/api/leads/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getLead(leadDeps(), actor, leadId(id)));
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/leads/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const input = editSchema.parse(await request.json());
    await updateLead(leadDeps(), actor, leadId(id), input);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/leads/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const outcome = await deleteLeads(leadDeleteDeps, actor, { ids: [leadId(id)] });
    const blocked = outcome.blocked[0];
    if (blocked) throw new ConflictError(BLOCK_MESSAGES[blocked.reason], blocked.reason === "try_again" ? { code: "try_again" } : undefined);
    // An id of another organization or an unknown id deletes nothing.
    if (outcome.deleted === 0) throw new NotFoundError("Lead not found");
    return { deleted: outcome.deleted };
  });
}
