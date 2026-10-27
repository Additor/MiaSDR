import { z } from "zod";
import { REPLY_TYPE_GROUPS } from "@/contexts/conversations/domain/reply-handling";
import { createReplyType, getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

/** The four fixed groups, the reply types with their rules and usage counts, and the reply handling settings. */
export const GET = () => withActor(async (actor) => ({ groups: REPLY_TYPE_GROUPS, ...(await getReplyTypeCatalog(replyHandlingDeps(), actor)) }));

/** Body: groupKey, name, and optional key, description, classificationGuidance, checkMode, replyDraft and followUps. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can change reply settings.", async (actor) => createReplyType(replyHandlingDeps(), actor, z.record(z.string(), z.unknown()).parse(await request.json())), 201);
