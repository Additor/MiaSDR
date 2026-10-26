import { z } from "zod";
import { setReplyType } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/**
 * `replyTypeKey: null` accepts the AI's held pick. A key overrides it. `expectedContextVersion` is the record version the person
 * saw; a mismatch answers 409. Either is recorded as a person's pick. Accepting a held stop request answers 409 with
 * `code: "stop_review"`: the client opens Stop contacting instead. No pick marks the person do not contact.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/inbox/[id]/reply-type">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ replyTypeKey: z.string().min(1).max(100).nullable(), expectedContextVersion: z.number().int().min(0) }).parse(await request.json());
    return setReplyType(replyDeps(), actor, id, body);
  });
}
