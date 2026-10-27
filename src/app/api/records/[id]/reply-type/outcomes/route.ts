import { getTypeChangeOutcomes } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

/**
 * What Change type would do for each active reply type other than the record's own, as three lines each:
 * `{ outcomes: [{ replyTypeId, outcome: { replyDraft, followUps, contact } }] }`. `?path=correct` is a person's pick for
 * the latest reply, which writes a draft when the type writes one. `?path=off_thread` is a change off the thread, which
 * writes none. Any other path answers 400.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/records/[id]/reply-type/outcomes">) {
  const { id } = await ctx.params;
  const path = new URL(request.url).searchParams.get("path");
  return withActor(async (actor) => ({ outcomes: await getTypeChangeOutcomes(replyHandlingDeps(), actor, id, path) }));
}
