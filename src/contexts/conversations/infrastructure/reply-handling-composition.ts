import type { ReplyHandlingDeps } from "../application/reply-handling";
import { drizzleReplyHandlingStore } from "./drizzle-reply-handling-store";
import { drizzleInboxStore } from "./drizzle-inbox-store";
import { ingestInbound, ingestInboundLinkedInMessage } from "./composition";

/**
 * Wires the reply handling use cases. Holds no mailer: the only code that can send a reply is `approveAndSendDraft`
 * and `sendLinkedInReply`, wired in `reply-send-composition.ts` for the Send routes and `send_reply`.
 */
export const replyHandlingDeps = (): ReplyHandlingDeps => ({
  store: drizzleReplyHandlingStore,
  inbox: drizzleInboxStore,
  now: () => new Date(),
  replay: { email: ingestInbound, linkedin: ingestInboundLinkedInMessage },
});
