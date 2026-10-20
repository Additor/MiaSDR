import { z } from "zod";
import { setMessageImportant } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/shared/api";

export async function POST(request: Request, ctx: RouteContext<"/api/inbox/messages/[id]/important">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const { important } = z.object({ important: z.boolean() }).parse(await request.json());
    await setMessageImportant(taskDeps(), actor, id, important);
    return { ok: true };
  });
}
