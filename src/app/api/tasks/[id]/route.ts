import { z } from "zod";
import { deleteTask, setTaskCompleted, updateTask } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/app/_lib/api";

const patch = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  /** YYYY-MM-DD, or null to clear the due date. */
  dueDay: z.string().max(10).nullable().optional(),
  timeZone: z.string().max(64).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  completed: z.boolean().optional(),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { completed, ...fields } = patch.parse(await request.json());
    if (Object.keys(fields).length > 0) await updateTask(taskDeps(), actor, id, fields);
    if (completed !== undefined) await setTaskCompleted(taskDeps(), actor, id, completed);
    return { ok: true };
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/tasks/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    await deleteTask(taskDeps(), actor, id);
    return { ok: true };
  });
}
