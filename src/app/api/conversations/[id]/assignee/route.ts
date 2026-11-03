import { z } from "zod";
import { assignConversation, claimConversation } from "@/contexts/conversations/actions/application/assignment";
import { assignmentDeps } from "@/contexts/conversations/actions/infrastructure/assignment-composition";
import { withActor } from "@/app/_lib/api";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("assign"), assignedTo: z.string().uuid().nullable(), expectedAssignedTo: z.string().uuid().nullable() }),
]);

/**
 * Who handles the replies of the conversation. Body: `{ action: "claim" }` takes an unassigned conversation, and
 * `{ action: "assign", assignedTo, expectedAssignedTo }` gives it to a member (`assignedTo: null` gives it to nobody).
 * `expectedAssignedTo` is who the caller saw holding it; a different holder answers 409. Answers
 * `{ conversationId, assignedTo, previousAssignedTo, changed }`.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/conversations/[id]/assignee">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = schema.parse(await request.json());
    return body.action === "claim" ? claimConversation(assignmentDeps(), actor, id) : assignConversation(assignmentDeps(), actor, id, body);
  });
}
