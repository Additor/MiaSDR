import type { DbTx } from "@/platform/db/client";
import type { OutreachHalt } from "../domain/enrollment-status";
import type { InboundClass } from "../email/domain/inbound";
import type { InboundEmail } from "../email/application/ports";

export interface SyncMailbox {
  id: string;
  organizationId: string;
  emailAddress: string;
  cursor: string | null;
}

/** What happened to one inbound message. Counted in the job result. */
export type InboundOutcome =
  | "hard_bounce"
  | "soft_bounce"
  /** Looks like a hard bounce but fails the checks (we never mailed that address, or nothing ties it to our send). Stored as an auto-reply, nothing suppressed. */
  | "unverified_bounce"
  | "reply"
  /** A real message that matches no enrollment (a stranger, or a lead writing in on their own). Stored in the inbox. */
  | "unmatched_message"
  | "auto_reply"
  | "own_message";

/** What filing a message in the Inbox answered. `created` carries how many enrollments the reply ended. */
export interface InboxFiled {
  status: "created" | "duplicate" | "quarantined";
  outreachStopped?: number;
}

/** One received email, as the Inbox files it. */
export interface InboxEmail {
  organizationId: string;
  accountRef: string;
  providerThreadId: string;
  providerMessageId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  from: { email: string; name: string | null };
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
  autoReply: boolean;
  possibleBounce?: boolean;
}

/** One received LinkedIn message, as the Inbox files it. */
export interface InboxLinkedInMessage {
  organizationId: string;
  accountRef: string;
  accountName: string | null;
  providerThreadId: string;
  providerMessageId: string;
  counterparty: { providerId: string; name: string | null; profileUrl: string | null; slug: string | null };
  personId: string | null;
  privateCampaignId?: string | null;
  bodyText: string;
  receivedAt: Date;
}

/**
 * Conversations' follow-up sequences, as outreach sees them. Suppressing an address ends that person's runs in the same
 * transaction. Conversations implements it and `src/composition/inbox-filing.ts` passes it in, so outreach never
 * imports conversations.
 */
export interface FollowUpStop {
  endEmailRunsTx(tx: DbTx, organizationId: string, email: string, halt: OutreachHalt, now: Date): Promise<number>;
}

/**
 * Files received messages in the Inbox. The conversations context implements it and `src/composition/inbox-filing.ts`
 * passes it in, so outreach never imports conversations. Both calls are idempotent per provider message id.
 */
export interface InboxFiling {
  email(input: InboxEmail): Promise<InboxFiled>;
  linkedin(input: InboxLinkedInMessage): Promise<InboxFiled>;
}

/** Failure history of one inbound message, kept in `inbound_events`. */
export interface MessageFailureState {
  attempts: number;
  /** Gave up after too many attempts. The message is skipped from now on. */
  deadLettered: boolean;
}

/** Port for inbound persistence. `applyInbound` is one transaction and safe to run twice for the same message. */
export interface InboundStore {
  /** Connected mailboxes not synced since `dueBefore`, never-synced and oldest first. */
  listDueMailboxIds(dueBefore: Date): Promise<string[]>;
  getMailbox(mailboxId: string): Promise<SyncMailbox | null>;
  applyInbound(mailbox: SyncMailbox, email: InboundEmail, classification: InboundClass, now: Date): Promise<InboundOutcome>;
  /**
   * Stores the new cursor only while the stored one is still `previous`, so a slow worker cannot move it backwards.
   * `note` is shown on the mailbox (a reset leaves a gap the user should know about); null clears the last error.
   */
  completeSync(mailboxId: string, previous: string | null, cursor: string, now: Date, note: string | null): Promise<void>;
  recordFailure(mailboxId: string, error: string): Promise<void>;
  /** Failure history for these provider message ids. Messages that never failed are absent from the map. */
  loadFailures(mailbox: SyncMailbox, providerMessageIds: string[]): Promise<Map<string, MessageFailureState>>;
  /** Counts one more failed attempt. At `maxAttempts` the message is dead-lettered. */
  recordMessageFailure(mailbox: SyncMailbox, email: InboundEmail, error: string, maxAttempts: number, now: Date): Promise<MessageFailureState>;
  /** The message applied after earlier failures. */
  clearMessageFailure(mailbox: SyncMailbox, providerMessageId: string, now: Date): Promise<void>;
  /** Provider message ids of this mailbox that a person queued for retry, or that failed earlier and wait for a replay. The cursor has moved past dead ones, so the sync fetches these by id. */
  loadRetryIds(mailbox: SyncMailbox, limit: number): Promise<string[]>;
  /** The provider no longer has this message: it stays dead-lettered, with the reason in its log. */
  recordMessageGone(mailbox: SyncMailbox, providerMessageId: string, now: Date): Promise<void>;
  /** Dead-lettered messages of this mailbox since `since`. */
  countDeadLetters(mailbox: SyncMailbox, since: Date): Promise<number>;
}
