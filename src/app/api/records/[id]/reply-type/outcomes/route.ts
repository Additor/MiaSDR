import { z } from "zod";
import { getTypeChangeOutcomes } from "@/contexts/conversations/application/reply-handling";
import { TYPE_CHANGE_PATHS } from "@/contexts/conversations/domain/reply-type";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

const pathSchema = z.enum(TYPE_CHANGE_PATHS);

/**
 * What Change type would do for each active reply type other than the record's own, as three lines each:
 * `{ outcomes: [{ replyTypeId, outcome: { replyDraft, followUps, contact } }] }`. `?path=correct` is a person's pick for
 * the latest reply, which writes a draft when the type writes one. `?path=off_thread` is a change off the thread, which
 * writes none. A missing or other path answers 400.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/records/[id]/reply-type/outcomes">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const path = pathSchema.parse(new URL(request.url).searchParams.get("path"));
    return { outcomes: await getTypeChangeOutcomes(replyHandlingDeps(), actor, id, path) };
  });
}
