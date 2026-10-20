import { z } from "zod";
import { getCampaignAfterReply, saveCampaignAfterReply } from "@/contexts/conversations/after-reply/application/after-reply";
import { afterReplyDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { withActor } from "@/shared/api";

type Ctx = RouteContext<"/api/campaigns/[id]/after-reply">;

/** The campaign's "After a reply" setting: the mode, the follow-up steps and the runs in progress. Any member may read it. */
export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor((actor) => getCampaignAfterReply(afterReplyDeps(), actor, id));
}

/**
 * Saves the setting. Body: `{ mode: "handoff" | "ai_drafts", steps?, confirmStopRuns? }`. The application layer validates the fields.
 * Answers 409 with `code` `mode_locked`, `runs_in_progress` (plus `count`) or `steps_required`, and 422 with `issues`.
 */
export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.record(z.string(), z.unknown()).parse(await request.json());
    return saveCampaignAfterReply(afterReplyDeps(), actor, id, { mode: body.mode, steps: body.steps, confirmStopRuns: body.confirmStopRuns });
  });
}
