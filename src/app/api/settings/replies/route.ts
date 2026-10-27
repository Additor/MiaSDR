import { z } from "zod";
import { getReplySettings, updateReplySettings } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () => withActor((actor) => getReplySettings(replyHandlingDeps(), actor));

/** The confidence floor (`autoApplyConfidence`, 0 to 1). */
export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await updateReplySettings(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
