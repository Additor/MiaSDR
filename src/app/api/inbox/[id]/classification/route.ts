import { z } from "zod";
import { setClassification } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/app/_lib/api";

/** `subcategoryKey: null` accepts the AI's held proposal. A key overrides it. `expectedContextVersion` is the record version the person saw; a mismatch answers 409. Either is recorded as a human decision. */
export async function POST(request: Request, ctx: RouteContext<"/api/inbox/[id]/classification">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ subcategoryKey: z.string().min(1).max(100).nullable(), expectedContextVersion: z.number().int().min(0) }).parse(await request.json());
    return setClassification(replyDeps(), actor, id, body);
  });
}
