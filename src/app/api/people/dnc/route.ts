import { z } from "zod";
import { setPeopleDoNotContact } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

const bodySchema = z.object({ ids: z.array(z.string().max(64)).min(1).max(200), reason: z.string().max(500).nullable().optional() });

/**
 * Bulk Mark do not contact: 1 to 200 people per request, one transaction each. `{ marked, skipped }`, where
 * a skip says `already_marked`, `not_found` or `retryable`. 422 without a reason.
 */
export async function POST(request: Request) {
  return withActor(async (actor) => {
    const { ids, reason } = bodySchema.parse(await request.json());
    return setPeopleDoNotContact(replyHandlingDeps(), actor, ids, { reason });
  });
}
