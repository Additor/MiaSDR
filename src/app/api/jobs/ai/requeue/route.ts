import { z } from "zod";
import { requeueFailedAiJobsSince } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withAdmin } from "@/shared/api";

const body = z.object({ since: z.iso.datetime({ offset: true }) });

/** Puts every AI job of the organization that failed at or after `since` back in the queue. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can requeue AI jobs.", async (actor) => {
    const { since } = body.parse(await request.json());
    return requeueFailedAiJobsSince(aiJobOpsDeps(), actor, new Date(since));
  });
