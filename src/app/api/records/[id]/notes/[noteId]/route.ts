import { z } from "zod";
import { deleteRecordNote } from "@/contexts/conversations/application/reply-handling";
import { assertCanDeleteNote, editNote } from "@/contexts/conversations/actions/application/tasks";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/app/_lib/api";

export async function PATCH(request: Request, ctx: RouteContext<"/api/records/[id]/notes/[noteId]">) {
  const { id, noteId } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json());
    await editNote(taskDeps(), actor, id, noteId, body);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/records/[id]/notes/[noteId]">) {
  const { id, noteId } = await ctx.params;
  return withActor(async (actor) => {
    await assertCanDeleteNote(taskDeps(), actor, id, noteId);
    await deleteRecordNote(replyHandlingDeps(), actor, id, noteId);
    return { ok: true };
  });
}
