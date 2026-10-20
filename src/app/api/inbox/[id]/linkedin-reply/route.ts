import { z } from "zod";
import { sendLinkedInReply } from "@/contexts/conversations/application/linkedin-reply";
import { linkedinReplyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withActor } from "@/shared/api";

const bodySchema = z
  .object({ text: z.string().max(20000), idempotencyKey: z.string().min(8).max(200), draftId: z.string().max(64).optional(), revision: z.number().int().optional() })
  .refine((b) => (b.draftId === undefined) === (b.revision === undefined), "draftId and revision go together.");

/**
 * A member types a reply, or edits the AI draft (`draftId` and the `revision` they reviewed), and presses Send: that is the approval. The client-made key makes a double click send once.
 * Refusals that need no send (cap, gap, pause, a reply already in flight) answer 409 and write nothing.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/inbox/[id]/linkedin-reply">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = bodySchema.parse(await request.json());
    return sendLinkedInReply(linkedinReplyDeps(), actor, id, body);
  });
}
