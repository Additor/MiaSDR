import { ConflictError, ValidationError } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { MAX_LINKEDIN_REPLY, type ReplyBlock } from "./linkedin-reply";
import { MANUAL_BODY_MAX } from "./manual-reply";

/**
 * The rules that decide whether a person or an agent may send a reply, or write a typed one, on a conversation
 * (docs/decisions.md, "Reply send rules" and "Agent sends"). Each store locks its rows in its own order and calls the checks its channel needs, in the order
 * the decision lists. A check throws its row of `REPLY_REFUSALS`. No I/O.
 */

export type ReplyChannel = "email" | "linkedin";

/** The longest reply text a channel sends: LinkedIn's limit for one message, and the typed email body limit. */
export const REPLY_TEXT_MAX: Record<ReplyChannel, number> = { email: MANUAL_BODY_MAX, linkedin: MAX_LINKEDIN_REPLY };

const WORDS = {
  email: { thread: "an email", place: "thread", check: "the mailbox" },
  linkedin: { thread: "a LinkedIn", place: "chat", check: "LinkedIn" },
} as const;

/** What a refusal's sentence may name besides the channel: the draft status, or the reason a draft went stale. */
type Detail = { status?: string; staleReason?: string | null };

/**
 * Every reason a reply is refused before the provider call, one row each: the error class, which sets the status the
 * route answers (`ConflictError` 409, `ValidationError` 422), and the sentence a person reads. A reason the person fixes
 * by editing the text is a validation error; every other one is a conflict with the state of the conversation.
 */
export const REPLY_REFUSALS = {
  handling_closed: { error: ConflictError, text: () => "Reply handling is marked done. Reopen it to reply." },
  wrong_channel: { error: ConflictError, text: (channel: ReplyChannel) => `This is not ${WORDS[channel].thread} conversation.` },
  conversation_closed: { error: ConflictError, text: () => "This conversation is closed." },
  no_email_address: { error: ConflictError, text: () => "This person has no email address." },
  no_chat: { error: ConflictError, text: () => "There is no LinkedIn chat for this conversation yet." },
  no_account: { error: ConflictError, text: () => "No LinkedIn account is connected for this conversation." },
  reply_sending: { error: ConflictError, text: (channel: ReplyChannel) => `A reply is already being sent in this ${WORDS[channel].place}.` },
  reply_uncertain: {
    error: ConflictError,
    text: (channel: ReplyChannel) => `An earlier reply in this ${WORDS[channel].place} has an unconfirmed outcome. Check ${WORDS[channel].check} and mark what you found first.`,
  },
  draft_not_reviewable: { error: ConflictError, text: (_: ReplyChannel, d: Detail) => `This draft is ${(d.status ?? "").replace(/_/g, " ")} and cannot be sent.` },
  draft_stale: { error: ConflictError, text: (_: ReplyChannel, d: Detail) => `${sentence(d.staleReason) ?? "This draft is out of date."} Review the thread and regenerate the draft.` },
  draft_changed: { error: ConflictError, text: () => "The draft changed since you reviewed it. Reload and approve the current text." },
  empty_text: { error: ValidationError, text: () => "The reply cannot be empty." },
  text_too_long: { error: ValidationError, text: (channel: ReplyChannel) => `The reply is longer than ${REPLY_TEXT_MAX[channel]} characters.` },
  // An agent's send (`send_reply` over MCP) meets these too, after every rule above. Each carries its reason as `code`.
  agent_send_off: { error: ConflictError, code: "agent_send_off", text: () => "Agents cannot send replies in this organization with this token. An owner or admin turns agent sending on under Settings, Organization; a token made before it was last turned off needs replacing." },
  agent_unverified_recipient: {
    error: ConflictError,
    code: "agent_unverified_recipient",
    text: () => "An agent replies only to a person a campaign reached in this conversation, or one a person here already answered. Reply yourself in MiaSDR first.",
  },
  agent_stop_requested: { error: ConflictError, code: "agent_stop_requested", text: () => "This person's latest message may ask to stop. A person reviews it in MiaSDR before an agent can reply." },
  agent_cc_not_allowed: { error: ConflictError, code: "agent_cc_not_allowed", text: () => "An agent cannot send a reply with CC. Remove the CC addresses from the draft, or send it yourself in MiaSDR." },
  agent_send_paused: { error: ConflictError, code: "agent_send_paused", text: () => "Sending is paused for this organization. Agents send nothing until a person resumes it." },
  agent_daily_cap: { error: ConflictError, code: "agent_daily_cap", text: () => "Agents reached today's reply limit for this organization, this person or this mailbox. It resets at midnight UTC." },
  agent_reply_gap: { error: ConflictError, code: "agent_reply_gap", text: () => "An agent already replied in this reply handling in the last 24 hours. Wait, or send this one yourself in MiaSDR." },
} as const satisfies Record<string, { error: typeof ConflictError | typeof ValidationError; code?: string; text: (channel: ReplyChannel, detail: Detail) => string }>;

export type ReplyRefusalReason = keyof typeof REPLY_REFUSALS;

const sentence = (text: string | null | undefined) => {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** The refusals only an agent's send meets. */
export type AgentReplyRefusal = Extract<ReplyRefusalReason, `agent_${string}`>;

/**
 * The error of one refusal row, for a store that reaches the reason outside the checks below. An `agent_*` row puts its
 * code, and the wait when it has one, in the details; the other rows answer the body they always did.
 */
export function replyRefusal(reason: ReplyRefusalReason, channel: ReplyChannel, detail: Detail = {}, wait?: { retryAfterSeconds: number }): ConflictError | ValidationError {
  const row: { error: typeof ConflictError | typeof ValidationError; code?: string; text: (channel: ReplyChannel, detail: Detail) => string } = REPLY_REFUSALS[reason];
  if (row.code) return new ConflictError(row.text(channel, detail), { code: row.code, ...wait });
  return new row.error(row.text(channel, detail));
}

/** What a draft writer returns, with nothing written, when reply handling is marked done under its conversation lock. */
export const HANDLING_CLOSED = "handling_closed" as const;

/** A person marked reply handling done (`conversations.workflow_state = 'closed'`). Reopen, or a new inbound message, opens it again. */
export function checkConversationOpen(conversation: { workflowState: string }, channel: ReplyChannel): void {
  if (conversation.workflowState === "closed") throw replyRefusal("handling_closed", channel);
}

/**
 * The conversation can carry a reply on `channel`: it is that channel's, it is active, and it has somewhere to send to,
 * the person's email address or the LinkedIn chat of a LinkedIn account.
 */
export function checkThreadWritable(
  thread: { channel: string; status: string; email?: string | null; chat?: string | null; accountRef?: string | null },
  channel: ReplyChannel,
): void {
  if (thread.channel !== channel) throw replyRefusal("wrong_channel", channel);
  if (thread.status !== "active") throw replyRefusal("conversation_closed", channel);
  if (channel === "email") {
    if (!thread.email) throw replyRefusal("no_email_address", channel);
    return;
  }
  if (!thread.chat) throw replyRefusal("no_chat", channel);
  if (!isUuid(thread.accountRef)) throw replyRefusal("no_account", channel);
}

/**
 * One reply of a conversation in flight at a time. `inFlight` is the conversation's draft in `sending` or
 * `delivery_uncertain`, if any. When it is the draft being sent (`draftId`, any case), its status refusal names it.
 */
export function checkNoneInFlight(inFlight: { id: string; status: string } | null | undefined, draftId: string | null, channel: ReplyChannel): void {
  if (!inFlight) return;
  if (draftId !== null && inFlight.id.toLowerCase() === draftId.toLowerCase()) throw replyRefusal("draft_not_reviewable", channel, { status: inFlight.status });
  throw replyRefusal(inFlight.status === "sending" ? "reply_sending" : "reply_uncertain", channel);
}

/**
 * The draft a person approves is still the one they reviewed: awaiting review, at the revision they saw, and written
 * for the conversation's current context version. A stale draft's refusal names why it went stale (`drafts.error`).
 * Returns the stale reason when only the version moved: the store marks the draft stale with it, commits, and throws
 * `staleDraftRefusal` with the same reason.
 */
export function checkDraftCurrent(
  draft: { status: string; error: string | null; revision: number; expectedContextVersion: number },
  expected: { revision: number; contextVersion: number },
  channel: ReplyChannel,
): string | null {
  if (draft.status === "stale") throw replyRefusal("draft_stale", channel, { staleReason: draft.error });
  if (draft.status !== "awaiting_review") throw replyRefusal("draft_not_reviewable", channel, { status: draft.status });
  if (draft.revision !== expected.revision) throw replyRefusal("draft_changed", channel);
  return draft.expectedContextVersion === expected.contextVersion ? null : NEWER_MESSAGE;
}

/**
 * The reasons a draft goes stale on a reply send rule, stored in `drafts.error` and named again by its refusal. Why a send
 * found its draft written for an older context version, and why marking reply handling done retired it.
 */
export const NEWER_MESSAGE = "A newer message arrived after this draft was written.";
export const MARKED_DONE = "A person marked reply handling done after this draft was written.";

export const staleDraftRefusal = (reason: string, channel: ReplyChannel) => replyRefusal("draft_stale", channel, { staleReason: reason });

/** Folds CRLF to LF and trims. Returns the text to send, or throws when it is empty or longer than the channel takes. */
export function checkReplyText(raw: string, channel: ReplyChannel): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") throw replyRefusal("empty_text", channel);
  if (text.length > REPLY_TEXT_MAX[channel]) throw replyRefusal("text_too_long", channel);
  return text;
}

/**
 * The LinkedIn account may send one more message now (`replyBlock`). A block answers 409 with its reason as `code`, and
 * the wait in seconds for the gap between replies.
 */
export function checkAccountReady(block: ReplyBlock | null): void {
  if (!block) return;
  throw new ConflictError(block.message, { code: block.reason, ...("retryAfterSeconds" in block ? { retryAfterSeconds: block.retryAfterSeconds } : {}) });
}
