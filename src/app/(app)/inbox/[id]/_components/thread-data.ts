import { cache } from "react";
import { getConversationDetail } from "@/contexts/conversations/application/reply-handling";
import { getConversationFollowUp } from "@/contexts/conversations/after-reply/application/follow-ups";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { followUpDeps } from "@/contexts/conversations/after-reply/infrastructure/follow-up-composition";
import type { Actor } from "@/shared/errors";

/*
 * The conversation behind a thread, read once per request: the side panel and the work column's Follow-ups and History both
 * use it, each inside its own Suspense boundary.
 */

export const conversationDetail = cache((actor: Actor, conversationId: string) => getConversationDetail(replyHandlingDeps(), actor, conversationId));

export const conversationAfterReply = cache((actor: Actor, conversationId: string) => getConversationFollowUp(followUpDeps(), actor, conversationId));
