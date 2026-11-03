import { z } from "zod";
import { createReplyType } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withAdmin } from "@/app/_lib/api";

/** Body: groupKey, name, and optional key, description, classificationGuidance, checkMode, replyDraft and followUps. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => createReplyType(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())), 201);
