import { ValidationError } from "@/shared/errors";
import { quarantineInbound } from "../application/reply-handling";
import { ingestInboundEmail } from "../application/ingest-inbound-email";
import { ingestInboundLinkedIn } from "../application/ingest-inbound-linkedin";
import type { InboundLinkedInInput } from "../application/linkedin-ports";
import type { InboxDeps } from "../application/inbox";
import type { InboundEmailInput, IngestOutcome, IngestResult, QuarantineInbound } from "../application/ports";
import { drizzleReplyHandlingStore } from "./drizzle-reply-handling-store";
import { drizzleConversationStore } from "./drizzle-conversation-store";
import { drizzleInboxStore } from "./drizzle-inbox-store";
import { drizzleLinkedInConversationStore } from "./drizzle-linkedin-conversation-store";
import { organizationTimeZone } from "./org-time-zone";

/** The knowledge base store. The knowledge use cases take it directly. */
export { drizzleKnowledgeStore as knowledgeStore } from "../ai/infrastructure/drizzle-knowledge-store";

/** The unread badge counts store. `unreadCounts` takes it directly. */
export { drizzleUnreadStore as unreadStore } from "./drizzle-unread-store";

export const inboxDeps = (): InboxDeps => ({ store: drizzleInboxStore, now: () => new Date(), timeZone: organizationTimeZone });

/** Parks a message no person can be found for. Reviewed at /inbox/unmatched. */
const quarantine: QuarantineInbound = (input) =>
  quarantineInbound({ exceptions: drizzleReplyHandlingStore }, input);

/** Files one received email in the master inbox, or parks it for review. Production callers use this one. */
export const receiveInbound = (input: InboundEmailInput): Promise<IngestOutcome> => ingestInboundEmail({ store: drizzleConversationStore, quarantine }, input);

/** Files one received LinkedIn message in the master inbox, or parks it for review. Production callers use this one. */
export const receiveInboundLinkedIn = (input: InboundLinkedInInput): Promise<IngestOutcome> =>
  ingestInboundLinkedIn({ store: drizzleLinkedInConversationStore, quarantine }, input);

/** Strict forms for a reviewer's replay and for tests: the message is filed, or the call throws. A parked message still stays parked. */
async function filed(outcome: Promise<IngestOutcome>): Promise<IngestResult> {
  const result = await outcome;
  if (result.status === "quarantined") throw new ValidationError(result.reason);
  return result;
}
export const ingestInbound = (input: InboundEmailInput): Promise<IngestResult> => filed(receiveInbound(input));
export const ingestInboundLinkedInMessage = (input: InboundLinkedInInput): Promise<IngestResult> => filed(receiveInboundLinkedIn(input));

/** Reply handling of one person or record, for the record pages and the old record URL. */
export { activeConversationOfRecord, personReplyHandling } from "./person-handling";
