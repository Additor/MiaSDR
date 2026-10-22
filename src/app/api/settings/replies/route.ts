import { z } from "zod";
import { getReplyTaxonomy, updateReplySettings } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

export const GET = () => withActor(async (actor) => (await getReplyTaxonomy(replyHandlingDeps(), actor)).settings);

/** Auto-apply threshold and the two review switches. */
export const PATCH = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => {
    await updateReplySettings(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
