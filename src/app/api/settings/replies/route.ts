import { z } from "zod";
import { getReplyTaxonomy, updateReplySettings } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor } from "@/app/_lib/api";

export const GET = () => withActor(async (actor) => (await getReplyTaxonomy(replyHandlingDeps(), actor)).settings);

/** Auto-apply threshold and the two review switches. */
export const PATCH = (request: Request) =>
  withActor(async (actor) => {
    await updateReplySettings(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json()));
    return { ok: true };
  });
