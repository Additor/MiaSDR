import { getTypeChangeOutcomes } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/**
 * What Change type would do for each active reply type other than the record's own, as three lines each:
 * `{ outcomes: [{ replyTypeId, outcome: { replyDraft, followUps, contact } }] }`.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/records/[id]/reply-type/outcomes">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => ({ outcomes: await getTypeChangeOutcomes(replyHandlingDeps(), actor, id) }));
}
