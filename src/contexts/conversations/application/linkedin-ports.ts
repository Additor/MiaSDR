import type { IngestResult, UnresolvedResult } from "./ports";

/** One message received from a LinkedIn connection, already normalized by the use case. */
export interface InboundLinkedInInput {
  organizationId: string;
  /** The LinkedIn account that received it (its id in this app, not the provider's). */
  accountRef: string;
  /** Display name of that account, shown as the recipient. */
  accountName: string | null;
  /** The provider's chat id. One chat is one conversation. */
  providerThreadId: string;
  providerMessageId: string;
  /** The other person in the chat. */
  counterparty: { providerId: string; name: string | null; profileUrl: string | null; /** Public profile slug, when the sender's URL had one. */ slug: string | null };
  /** The lead this message belongs to when the caller already knows it (a reply to an enrolled lead). */
  personId: string | null;
  bodyText: string;
  receivedAt: Date;
  /** The personal campaign this lead is in on the receiving account, if any. The thread then stays out of the Inbox, the AI and the CRM. */
  privateCampaignId?: string | null;
}

/** Port for LinkedIn inbound persistence. `ingestLinkedIn` is one transaction and safe to run twice for the same message.
 * It answers `unresolved`, writing nothing, when the chat is new and the sender cannot be tied to a person. */
export interface InboundLinkedInStore {
  ingestLinkedIn(input: InboundLinkedInInput): Promise<IngestResult | UnresolvedResult>;
}
