import type { AttemptRow } from "./reply-ports";

/** A gateway failure as the reply path sees it. definite: LinkedIn refused, nothing was sent. unknown: it may have gone out. */
export class LinkedInReplyError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "unknown",
    /** rate_limited pauses the account, auth disconnects it. */
    readonly code: "rate_limited" | "auth" | "other",
  ) {
    super(message);
  }
}

/** Port to LinkedIn for one organization. The adapter lives in infrastructure and maps provider errors to LinkedInReplyError. */
export interface LinkedInReplySender {
  /** Null means the organization has no LinkedIn connection. */
  available(organizationId: string): Promise<boolean>;
  send(input: { organizationId: string; account: string; chat: string; text: string }): Promise<{ messageId: string | null }>;
  /** A message from the account owner in the chat with this text after `since`. Throws when LinkedIn cannot answer. */
  findSent(input: { organizationId: string; account: string; chat: string; text: string; since: Date }): Promise<{ messageId: string | null } | null>;
}

/** What one claimed reply knows. Built from the approval snapshot stored on the ledger row. */
export interface LinkedInReplyContext {
  attempt: AttemptRow;
  organizationId: string;
  draftId: string;
  conversationId: string;
  recordId: string;
  personId: string;
  accountId: string;
  providerAccountId: string;
  chat: string;
  text: string;
}

export type BeginLinkedInReply = { kind: "replay"; attempt: AttemptRow } | { kind: "started"; send: LinkedInReplyContext };

export type LinkedInReplyBlocker = "do_not_contact" | "not_connected" | "paused";

export interface LinkedInReplyPanel {
  conversationId: string;
  recipient: string | null;
  accountLabel: string;
  /** Why a reply cannot go out right now, in words for the person. */
  issue: string | null;
  doNotContact: boolean;
  usedToday: number;
  dailyLimit: number;
  /**
   * The newest open draft: an AI draft or text kept after a refusal, a send in flight, one waiting for a person's check,
   * or a `stale` draft written before a newer message arrived (it cannot be sent).
   */
  draft: { id: string; status: string; text: string; error: string | null; revision: number; source: "ai" | "manual" } | null;
}

export interface LinkedInReplyStore {
  /**
   * One transaction: locks the conversation and the account, replays a known idempotency key, applies the reply send
   * rules (`domain/reply-send.ts`): open reply handling, a writable chat, one reply in flight, a current draft, the text
   * as typed (trimmed here), then pause, daily cap and gap. Writes the draft and the ledger row (the claim). Throws
   * ConflictError (with details.retryAfterSeconds for the gap), or ValidationError for empty or oversized text.
   * With `draft`, the person approves that draft at that revision (its text replaced by `text`): 404 when it is not a
   * LinkedIn draft of this conversation, 409 when it is no longer `awaiting_review`, was edited since, or was written
   * before a newer message arrived (it turns `stale`). Without `draft` the text goes out as a typed reply.
   */
  begin(input: { organizationId: string; conversationId: string; text: string; idempotencyKey: string; actorUserId: string; now: Date; draft?: { id: string; revision: number } }): Promise<BeginLinkedInReply>;
  checkBlockers(send: LinkedInReplyContext, now: Date): Promise<{ reason: LinkedInReplyBlocker; message: string } | null>;
  markSent(send: LinkedInReplyContext, sent: { providerMessageId: string | null }, now: Date, note?: string): Promise<void>;
  /** Definite refusal: the draft goes back to review with its text. */
  markFailed(send: LinkedInReplyContext, error: string): Promise<void>;
  markUncertain(send: LinkedInReplyContext, error: string): Promise<void>;
  pauseAccount(send: LinkedInReplyContext, until: Date): Promise<void>;
  disconnectAccount(send: LinkedInReplyContext, error: string): Promise<void>;
  panel(organizationId: string, conversationId: string, now: Date): Promise<LinkedInReplyPanel | null>;
  listUnsettled(olderThan: Date, limit: number): Promise<Array<{ send: LinkedInReplyContext; status: "sending" | "delivery_uncertain"; startedAt: Date }>>;
}
