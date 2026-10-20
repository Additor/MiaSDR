import { z } from "zod";
import { addCrmNote } from "@/contexts/conversations/application/crm";
import { listPersonNotes } from "@/contexts/conversations/actions/application/tasks";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/shared/api";

/** Every note of the person, record-bound ones included, newest first. */
export async function GET(_request: Request, ctx: RouteContext<"/api/people/[personId]/notes">) {
  const { personId } = await ctx.params;
  return withActor(async (actor) => listPersonNotes(taskDeps(), actor, personId));
}

/** A note on the person without a reply record (`record_id` null). */
export async function POST(request: Request, ctx: RouteContext<"/api/people/[personId]/notes">) {
  const { personId } = await ctx.params;
  return withActor(
    async (actor) => addCrmNote(crmDeps(), actor, { personId }, z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json())),
    201,
  );
}
