import { z } from "zod";
import { setReplyType } from "@/contexts/conversations/application/reply-management";
import { followDoNotContactCategory } from "@/contexts/conversations/application/reply-handling";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/**
 * `replyTypeKey: null` accepts the AI's held proposal. A key overrides it. `expectedContextVersion` is the record version the person
 * saw; a mismatch answers 409. Either is recorded as a human decision, so landing in Do not contact also marks the person, as a
 * move off the thread does.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/inbox/[id]/classification">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ replyTypeKey: z.string().min(1).max(100).nullable(), expectedContextVersion: z.number().int().min(0) }).parse(await request.json());
    const result = await setReplyType(replyDeps(), actor, id, body);
    await followDoNotContactCategory(replyHandlingDeps(), actor, result);
    return result;
  });
}
