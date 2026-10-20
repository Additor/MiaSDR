import { z } from "zod";
import { createTask, listTasks } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/shared/api";

export async function GET(_request: Request, ctx: RouteContext<"/api/crm/records/[id]/tasks">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => listTasks(taskDeps(), actor, { state: "all", recordId: id }));
}

export async function POST(request: Request, ctx: RouteContext<"/api/crm/records/[id]/tasks">) {
  const { id } = await ctx.params;
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
    return createTask(taskDeps(), actor, id, body.data);
  }, 201);
}
