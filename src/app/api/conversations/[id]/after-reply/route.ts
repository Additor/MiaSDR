import { z } from "zod";
import {
cancelFollowUpRun,pauseFollowUpRun,
restartFollowUpRun,
resumeFollowUpRun,
skipFollowUpStep
} from "@/contexts/conversations/after-reply/application/follow-ups";
import { followUpDeps } from "@/contexts/conversations/after-reply/infrastructure/follow-up-composition";
import { withActor } from "@/app/_lib/api";
import { ValidationError } from "@/shared/errors";

type Ctx = RouteContext<"/api/conversations/[id]/after-reply">;

const ACTIONS = ["pause", "resume", "skip", "cancel", "restart"] as const;

/**
 * Controls for the conversation's run. Body: `{ action: "pause" | "resume" | "skip" | "cancel" | "restart" }`.
 * `skip` answers `{ skipped, next }`, `restart` answers `{ runId, created }`, the others `{ ok: true }`. Nothing here sends.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const parsed = z.object({ action: z.string() }).parse(await request.json());
    const action = ACTIONS.find((a) => a === parsed.action);
    if (!action) throw new ValidationError(`Unknown action. Use one of: ${ACTIONS.join(", ")}.`);
    const deps = followUpDeps();
    switch (action) {
      case "pause":
        await pauseFollowUpRun(deps, actor, id);
        return { ok: true };
      case "resume":
        await resumeFollowUpRun(deps, actor, id);
        return { ok: true };
      case "cancel":
        await cancelFollowUpRun(deps, actor, id);
        return { ok: true };
      case "skip":
        return skipFollowUpStep(deps, actor, id);
      case "restart":
        return restartFollowUpRun(deps, actor, id);
    }
  });
}
