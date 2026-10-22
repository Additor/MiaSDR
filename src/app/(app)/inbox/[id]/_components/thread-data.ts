import { cache } from "react";
import { getRecordDetail } from "@/contexts/conversations/application/reply-handling";
import { getRecordSequence } from "@/contexts/conversations/after-reply/application/sequences";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { sequenceDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import type { Actor } from "@/shared/errors";

/*
 * The record behind a thread, read once per request: the side panel and the work column's Follow-ups and History both
 * use it, each inside its own Suspense boundary.
 */

export const recordDetail = cache((actor: Actor, recordId: string) => getRecordDetail(replyHandlingDeps(), actor, recordId));

export const recordAfterReply = cache((actor: Actor, recordId: string) => getRecordSequence(sequenceDeps(), actor, recordId));
