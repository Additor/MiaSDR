import type { InboxView } from "../domain/inbox-filter";
import type { IdentityPayload } from "./reply-handling";

/** One inbound email, already normalized by the use case. */
export interface InboundEmailInput {
  organizationId: string;
  /** Mailbox address that received it. */
  accountRef: string;
  providerThreadId: string;
  providerMessageId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  from: { email: string; name: string | null };
  to: string[];
  /** Cc and Resent-Cc addresses of the message. Remembered per lead as reply hints, never emailed on their own. */
  cc?: string[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
  /** Machine-written reply (out of office and similar). Stored, but it asks nothing of a human. */
  autoReply: boolean;
  /** Looks like a delivery failure for an address we mailed, but the sender could not be verified. Metadata only. */
  possibleBounce?: boolean;
  /** The lead a reviewer chose for a quarantined message. Ignored when the thread is already known. */
  personId?: string | null;
}

export interface IngestResult {
  /** `duplicate`: this message was stored before and nothing changed. */
  status: "created" | "duplicate";
  conversationId: string;
  messageId: string;
  personId: string;
  personCreated: boolean;
  /** Campaign enrollments this message ended (a genuine reply stops every channel). Absent on a duplicate. */
  outreachStopped?: number;
}

/** The message was parked as an identity exception: nothing was filed, a person reviews it at /inbox/unmatched. */
export interface QuarantinedResult {
  status: "quarantined";
  exceptionId: string;
  reason: string;
}

/** What the use cases return. Only `IngestResult` files a message. */
export type IngestOutcome = IngestResult | QuarantinedResult;

/** Why a store could not file a message under any person. The use case quarantines it. */
export interface UnresolvedResult {
  status: "unresolved";
  reason: string;
  identityValue: string | null;
}

/** Parks a message for review. Safe to call twice for the same provider event. */
export type QuarantineInbound = (input: { organizationId: string; sourceEventKey: string; identityValue: string | null; reason: string; payload: IdentityPayload }) => Promise<{ id: string; created: boolean }>;

/** Port for inbound persistence. `ingestEmail` is one transaction and safe to run twice for the same message. */
export interface InboundConversationStore {
  ingestEmail(input: InboundEmailInput): Promise<IngestResult>;
}

export interface InboxFilter {
  /** Matches the person's name or email and the subject or body of any message in the thread. */
  query?: string;
  /**
   * `unread`: has unread inbound mail. `action`: the record waits for a human. `sent`: the latest message is ours.
   * `replied`: the latest message is a human reply that is not out of office. `ooo`: filed under out of office.
   * `automated`: machine mail. `all` hides automated threads unless a search is active. `scheduled` is served by `listScheduled`.
   */
  view: InboxView;
  page: number;
  pageSize: number;
  leadIds?: string[];
  /** Name or email fragment of the person. */
  leadQuery?: string;
  /** People enrolled in any of these campaigns. */
  campaignIds?: string[];
  /** Conversations on any of these mailboxes. */
  mailboxIds?: string[];
  replyTypeKeys?: string[];
  groupKeys?: string[];
  /** Latest message at or after this instant. */
  from?: Date | null;
  /** Latest message before this instant. */
  to?: Date | null;
}

export interface ScheduledRow {
  /** `campaign`: a campaign step. `sequence`: an After a reply follow-up step. */
  kind: "campaign" | "sequence";
  id: string;
  personId: string;
  personName: string | null;
  personEmail: string | null;
  channel: string;
  /** Campaign or sequence name. */
  sourceName: string;
  stepLabel: string;
  subject: string | null;
  mailbox: string | null;
  dueAt: Date;
}

export interface InboxFilterOptions {
  mailboxes: Array<{ id: string; label: string }>;
  campaigns: Array<{ id: string; label: string }>;
  replyTypes: Array<{ key: string; label: string }>;
  leads: Array<{ id: string; label: string }>;
}

export interface InboxRow {
  conversationId: string;
  channel: string;
  accountRef: string;
  personId: string;
  personName: string | null;
  personEmail: string | null;
  subject: string | null;
  snippet: string;
  lastMessageAt: Date;
  lastDirection: "inbound" | "outbound";
  unreadCount: number;
  /** The latest inbound message is an automatic reply. */
  autoReply: boolean;
  /** The latest inbound message looks like a bounce notice that could not be verified, so nothing was suppressed. */
  possibleBounce: boolean;
  /** Some message in the conversation is starred. */
  hasImportant: boolean;
  /** The latest message is machine mail (header flags, no-reply or DMARC sender, delivery-failure subject). */
  automated: boolean;
  groupKey: string | null;
  replyTypeName: string | null;
}

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  /** `sequence`: an outreach step from a campaign. `message`: stored in the conversation itself. */
  source: "message" | "sequence";
  subject: string | null;
  from: string | null;
  to: string | null;
  /** CC addresses of the message, when the headers carried any. */
  cc?: string[];
  bodyText: string;
  at: Date;
  autoReply: boolean;
  /** An unverified bounce notice: stored for a human to read, suppresses nothing. */
  possibleBounce: boolean;
  unread: boolean;
  /** A person starred this message. Only stored messages carry the flag. */
  important: boolean;
}

export interface ThreadDetail {
  conversationId: string;
  recordId: string;
  channel: string;
  accountRef: string;
  /** What to show for the receiving account: the mailbox address, or the LinkedIn account's name. */
  accountLabel: string;
  workflowState: string;
  /** The record's version. A reclassification bumps it, which the thread page watches to refresh the draft. */
  contextVersion: number;
  /** Status of the newest draft that is neither discarded nor stale, or null. */
  latestDraftStatus: string | null;
  person: { id: string; name: string | null; email: string | null; linkedinUrl: string | null; title: string | null; company: string | null };
  messages: ThreadMessage[];
  unreadCount: number;
}

export interface InboxStore {
  /** `automatedHidden` counts the threads the `all` view leaves out under the same filters. */
  list(organizationId: string, filter: InboxFilter): Promise<{ rows: InboxRow[]; total: number; automatedHidden: number }>;
  /** Queued next steps of active enrollments and runs, soonest first. Honors lead, campaign, mailbox and date filters. */
  listScheduled(organizationId: string, filter: InboxFilter): Promise<{ rows: ScheduledRow[]; total: number }>;
  filterOptions(organizationId: string, leadIds: string[]): Promise<InboxFilterOptions>;
  thread(organizationId: string, conversationId: string): Promise<ThreadDetail | null>;
  /** Returns how many messages changed. */
  markRead(organizationId: string, conversationId: string, at: Date): Promise<number | null>;
}
