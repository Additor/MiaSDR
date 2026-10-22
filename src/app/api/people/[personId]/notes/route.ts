import { z } from "zod";
import { addRecordNote } from "@/contexts/conversations/application/reply-handling";
import { listPersonNotes } from "@/contexts/conversations/actions/application/tasks";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/app/_lib/api";

/** Every note of the person, record-bound ones included, newest first. */
export async function GET(_request: Request, ctx: RouteContext<"/api/people/[personId]/notes">) {
  const { personId } = await ctx.params;
  return withActor(async (actor) => listPersonNotes(taskDeps(), actor, personId));
}

/** A note on the person without a reply record (`record_id` null). */
export async function POST(request: Request, ctx: RouteContext<"/api/people/[personId]/notes">) {
  const { personId } = await ctx.params;
  return withActor(
    async (actor) => addRecordNote(replyHandlingDeps(), actor, { personId }, z.object({ title: z.string().max(200).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(await request.json())),
    201,
  );
}
