import { z } from "zod";
import { getReplyTaxonomy, updateReplyAiInstructions } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export const GET = () =>
  withActor(async (actor) => {
    const { settings } = await getReplyTaxonomy(replyHandlingDeps(), actor);
    return { draftInstructions: settings.draftInstructions, classificationInstructions: settings.classificationInstructions };
  });

export const PUT = (request: Request) =>
  withActor(async (actor) => {
    await updateReplyAiInstructions(replyHandlingDeps(), actor, z.object({ draftInstructions: z.unknown().optional(), classificationInstructions: z.unknown().optional() }).parse(await request.json()));
    return { ok: true };
  });
