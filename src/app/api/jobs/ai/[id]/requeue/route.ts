import { requeueAiJob } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { withAdmin } from "@/app/_lib/api";

/** Puts one failed AI job (classification or draft) back in the queue. */
export const POST = (_request: Request, { params }: { params: Promise<{ id: string }> }) =>
  withAdmin("Only an owner or admin can requeue AI jobs.", async (actor) => requeueAiJob(aiJobOpsDeps(), actor, (await params).id));
