import type { AgentVia } from "@/shared/errors";
import type { AttemptRow } from "./reply-ports";

/** A gateway failure as the reply path sees it. definite: LinkedIn refused, nothing was sent. unknown: it may have gone out. */
export class LinkedInReplyError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "unknown",
    /** rate_limited pauses the account, auth disconnects it. */
    readonly code: "rate_limited" | "auth" | "other",
    /** For `rate_limited`: how long the limit lasts, when LinkedIn's side says. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Where a reply goes. */
export interface LinkedInReplyAddress {
  organizationId: string;
  accountId: string;
  account: string;
  chat: string;
  /** The other person's member id and public slug, for a provider that addresses people rather than chats. */
  member: string | null;
  slug: string | null;
}

/** Looks at LinkedIn for one organization. It never sends. */
export interface LinkedInSentFinder {
  /** False means this account's LinkedIn connection is gone. */
  available(input: { organizationId: string; accountId: string }): Promise<boolean>;
  /** A message from the account owner in the chat with this text after `since`. Throws when LinkedIn cannot answer. */
  findSent(input: LinkedInReplyAddress & { text: string; since: Date; sendKey: string }): Promise<{ messageId: string | null } | null>;
}

/**
 * Port to LinkedIn that also sends. The adapter lives in infrastructure and maps provider errors to
 * LinkedInReplyError. Only the send deps (`reply-send-composition.ts`) hold one.
 */
export interface LinkedInReplySender extends LinkedInSentFinder {
  /** `unlessRepliedAfter`: refused with a definite error when the person wrote after this moment, where the vendor can read the thread first. */
  send(input: LinkedInReplyAddress & { text: string; sendKey: string; unlessRepliedAfter: Date | null }): Promise<{ messageId: string | null }>;
}

/** What one claimed reply knows. Built from the approval snapshot stored on the ledger row. */
export interface LinkedInReplyContext {
  attempt: AttemptRow;
  organizationId: string;
  draftId: string;
  threadId: string;
  conversationId: string;
  personId: string;
  accountId: string;
  providerAccountId: string;
  chat: string;
  /** Null on an attempt begun before these were kept. */
  member: string | null;
  slug: string | null;
  text: string;
  /** When an agent's draft was last written. Null: a person is sending what they just read and typed. */
  draftWrittenAt: Date | null;
}

export type BeginLinkedInReply = { kind: "replay"; attempt: AttemptRow } | { kind: "started"; send: LinkedInReplyContext };

export type LinkedInReplyBlocker = "do_not_contact" | "not_connected" | "paused";

export interface LinkedInReplyPanel {
  threadId: string;
  recipient: string | null;
  accountLabel: string;
  /** Why a reply cannot go out right now, in words for the person. */
  issue: string | null;
  /** A person marked reply handling done: no reply goes out and no draft is written until Reopen. */
  markedDone: boolean;
  doNotContact: boolean;
  usedToday: number;
  dailyLimit: number;
  /**
   * The newest open draft: an AI draft or text kept after a refusal, a send in flight, one waiting for a person's check,
   * or a `stale` draft written before a newer message arrived (it cannot be sent).
   */
  draft: {
    id: string;
    status: string;
    text: string;
    error: string | null;
    revision: number;
    source: "ai" | "manual";
    /** The name of the MCP token whose agent wrote the current text or asked for it, or null. */
    writtenVia: string | null;
  } | null;
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
  /**
   * Claims the reply for sending and writes the ledger row. A person's `text` replaces the open draft's. With `via`, an
   * agent sends `draft` as saved, `text` is ignored, and the agent rules run after the person's.
   */
  begin(input: { organizationId: string; threadId: string; text?: string; idempotencyKey: string; actorUserId: string; now: Date; draft?: { id: string; revision: number }; via?: AgentVia }): Promise<BeginLinkedInReply>;
  checkBlockers(send: LinkedInReplyContext, now: Date): Promise<{ reason: LinkedInReplyBlocker; message: string } | null>;
  markSent(send: LinkedInReplyContext, sent: { providerMessageId: string | null }, now: Date, note?: string): Promise<void>;
  /** Definite refusal: the draft goes back to review with its text. */
  markFailed(send: LinkedInReplyContext, error: string): Promise<void>;
  markUncertain(send: LinkedInReplyContext, error: string): Promise<void>;
  /** Puts an uncertain attempt behind the others after a check that could not settle it. */
  noteChecked(send: LinkedInReplyContext, now: Date): Promise<void>;
  pauseAccount(send: LinkedInReplyContext, until: Date): Promise<void>;
  disconnectAccount(send: LinkedInReplyContext, error: string): Promise<void>;
  panel(organizationId: string, threadId: string, now: Date): Promise<LinkedInReplyPanel | null>;
  listUnsettled(olderThan: Date, limit: number): Promise<Array<{ send: LinkedInReplyContext; status: "sending" | "delivery_uncertain"; startedAt: Date }>>;
}
