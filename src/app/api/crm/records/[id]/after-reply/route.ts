import { z } from "zod";
import {
  cancelSequenceRun,
  getRecordSequence,
  pauseSequenceRun,
  restartSequenceRun,
  resumeSequenceRun,
  skipSequenceStep,
} from "@/contexts/conversations/after-reply/application/sequences";
import { sequenceDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { withActor } from "@/app/_lib/api";
import { ValidationError } from "@/shared/errors";

type Ctx = RouteContext<"/api/crm/records/[id]/after-reply">;

const ACTIONS = ["pause", "resume", "skip", "cancel", "restart"] as const;

/** The record's follow-up run under its campaign's "After a reply" setting. */
export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor((actor) => getRecordSequence(sequenceDeps(), actor, id));
}

/**
 * Controls for the record's run. Body: `{ action: "pause" | "resume" | "skip" | "cancel" | "restart" }`.
 * `skip` answers `{ skipped, next }`, `restart` answers `{ runId, created }`, the others `{ ok: true }`. Nothing here sends.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const parsed = z.object({ action: z.string() }).parse(await request.json());
    const action = ACTIONS.find((a) => a === parsed.action);
    if (!action) throw new ValidationError(`Unknown action. Use one of: ${ACTIONS.join(", ")}.`);
    const deps = sequenceDeps();
    switch (action) {
      case "pause":
        await pauseSequenceRun(deps, actor, id);
        return { ok: true };
      case "resume":
        await resumeSequenceRun(deps, actor, id);
        return { ok: true };
      case "cancel":
        await cancelSequenceRun(deps, actor, id);
        return { ok: true };
      case "skip":
        return skipSequenceStep(deps, actor, id);
      case "restart":
        return restartSequenceRun(deps, actor, id);
    }
  });
}
