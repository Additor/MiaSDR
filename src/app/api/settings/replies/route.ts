import { z } from "zod";
import { updateReplySettings } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withAdmin } from "@/app/_lib/api";

/** The confidence floor (`autoApplyConfidence`, 0 to 1). */
export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await updateReplySettings(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
