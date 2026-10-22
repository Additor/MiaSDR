import type { ReplyHandlingDeps } from "../application/reply-handling";
import { drizzleReplyHandlingStore } from "./drizzle-reply-handling-store";
import { drizzleInboxStore } from "./drizzle-inbox-store";
import { ingestInbound, ingestInboundLinkedInMessage } from "./composition";

/**
 * Wires the reply handling use cases. Holds no mailer: the only code that can send a reply is `approveAndSendDraft`,
 * wired in `ai-composition.ts`.
 */
export const replyHandlingDeps = (): ReplyHandlingDeps => ({
  store: drizzleReplyHandlingStore,
  inbox: drizzleInboxStore,
  now: () => new Date(),
  replay: { email: ingestInbound, linkedin: ingestInboundLinkedInMessage },
});
