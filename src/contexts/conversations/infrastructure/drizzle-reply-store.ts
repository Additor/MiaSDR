import type { ReplyStore } from "../application/reply-ports";
import { replyDraftMethods } from "./reply-store-drafts";
import { replyHandlingMethods } from "./reply-store-handling";
import { replySendMethods } from "./reply-store-sending";

/** The reply store: drafts and the reply panel, sending and its settlement, and the human reply handling. */
export const drizzleReplyStore: ReplyStore = { ...replyDraftMethods, ...replySendMethods, ...replyHandlingMethods };
