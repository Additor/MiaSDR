import { z } from "zod";
import { deleteCrmNote } from "@/contexts/conversations/application/crm";
import { assertCanDeleteNote, editNote } from "@/contexts/conversations/actions/application/tasks";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/shared/api";

/** Any note of the person, record-bound or not. Only the author or an admin changes it, as on the record routes. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/people/[personId]/notes/[noteId]">) {
  const { personId, noteId } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json());
    await editNote(taskDeps(), actor, { personId }, noteId, body);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/people/[personId]/notes/[noteId]">) {
  const { personId, noteId } = await ctx.params;
  return withActor(async (actor) => {
    await assertCanDeleteNote(taskDeps(), actor, { personId }, noteId);
    await deleteCrmNote(crmDeps(), actor, { personId }, noteId);
    return { ok: true };
  });
}
