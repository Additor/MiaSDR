import { z } from "zod";
import { createTask, listTasks } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/app/_lib/api";

/** Every task of the person, record-bound ones included. */
export async function GET(_request: Request, ctx: RouteContext<"/api/people/[personId]/tasks">) {
  const { personId } = await ctx.params;
  return withActor(async (actor) => listTasks(taskDeps(), actor, { state: "all", personId }));
}

/** A task on the person without a reply record (`record_id` null). */
export async function POST(request: Request, ctx: RouteContext<"/api/people/[personId]/tasks">) {
  const { personId } = await ctx.params;
  const body = z
    .object({
      name: z.string().min(1).max(200),
      description: z.string().max(4000).nullable().optional(),
      dueDay: z.string().max(10).nullable().optional(),
      timeZone: z.string().max(64).nullable().optional(),
      assigneeId: z.string().uuid().nullable().optional(),
    })
    .safeParse(await request.json().catch(() => null));
  return withActor(async (actor) => {
    if (!body.success) throw body.error;
    return createTask(taskDeps(), actor, { personId }, body.data);
  }, 201);
}
