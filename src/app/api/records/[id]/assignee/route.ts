import { z } from "zod";
import { assignRecord, claimRecord } from "@/contexts/conversations/actions/application/assignment";
import { assignmentDeps } from "@/contexts/conversations/actions/infrastructure/assignment-composition";
import { withActor } from "@/app/_lib/api";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim") }),
  z.object({ action: z.literal("assign"), assignedTo: z.string().uuid().nullable(), expectedAssignedTo: z.string().uuid().nullable() }),
]);

/**
 * Who handles the replies of the record. Body: `{ action: "claim" }` takes an unassigned conversation, and
 * `{ action: "assign", assignedTo, expectedAssignedTo }` gives it to a member (`assignedTo: null` gives it to nobody).
 * `expectedAssignedTo` is who the caller saw holding it; a different holder answers 409. Answers
 * `{ recordId, assignedTo, previousAssignedTo, changed }`.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/records/[id]/assignee">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = schema.parse(await request.json());
    return body.action === "claim" ? claimRecord(assignmentDeps(), actor, id) : assignRecord(assignmentDeps(), actor, id, body);
  });
}
