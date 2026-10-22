import { z } from "zod";
import { setPersonDoNotContact } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/** Setting it stops the person's pending and active campaign enrollments and retires open drafts. */
export async function POST(request: Request, ctx: RouteContext<"/api/people/[personId]/dnc">) {
  const { personId } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ enabled: z.boolean(), reason: z.string().max(500).nullable().optional() }).parse(await request.json());
    return setPersonDoNotContact(replyHandlingDeps(), actor, personId, body);
  });
}
