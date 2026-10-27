import { z } from "zod";
import { getReplySettings, updateReplyAiInstructions } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () =>
  withActor(async (actor) => {
    const settings = await getReplySettings(replyHandlingDeps(), actor);
    return { draftInstructions: settings.draftInstructions, classificationInstructions: settings.classificationInstructions };
  });

export const PUT = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await updateReplyAiInstructions(replyHandlingDeps(), actor, z.object({ draftInstructions: z.unknown().optional(), classificationInstructions: z.unknown().optional() }).parse(await request.json()));
    return { ok: true };
  });
