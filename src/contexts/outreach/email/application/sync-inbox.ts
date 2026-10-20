import { classifyInbound } from "../domain/inbound";
import type { InboundOutcome, InboundStore } from "../../application/inbound-ports";
import type { Clock, MailboxProvider } from "../../application/ports";

export interface InboxDeps {
  store: InboundStore;
  provider: MailboxProvider;
  clock: Clock;
  /** A mailbox synced within this many seconds is not due again. */
  minIntervalSeconds: number;
}

/** A message that fails this many times in a row is recorded in `inbound_events` and skipped, so it cannot hold the cursor back. */
export const MAX_MESSAGE_ATTEMPTS = 5;
const DEAD_LETTER_WINDOW_MS = 7 * 24 * 3600 * 1000;

export type InboundCounts = Partial<Record<InboundOutcome | "dead_lettered", number>>;

export type SyncOutcome =
  | { kind: "skipped" }
  | { kind: "synced"; counts: InboundCounts; reset: boolean }
  | { kind: "failed"; error: string; counts: InboundCounts };

export const INBOUND_EVENTS_PATH = "/settings/inbound-events";

export const deadLetterNote = (count: number) =>
  `${count} inbound message${count === 1 ? "" : "s"} failed ${MAX_MESSAGE_ATTEMPTS} times and ${count === 1 ? "was" : "were"} skipped. Review ${count === 1 ? "it" : "them"} at ${INBOUND_EVENTS_PATH}.`;

const DEAD_LETTER_NOTE = /\d+ inbound messages? failed \d+ times and (?:was|were) skipped\. (?:Review (?:it|them) at \/settings\/inbound-events\.|See the inbound events table\.)\s*/;

export const hasDeadLetterNote = (lastError: string | null) => lastError !== null && DEAD_LETTER_NOTE.test(lastError);

/** The mailbox error text without the dead-letter sentence, so the other notes in it survive. Null when nothing is left. */
export const withoutDeadLetterNote = (lastError: string | null): string | null => {
  const rest = (lastError ?? "").replace(DEAD_LETTER_NOTE, "").trim();
  return rest === "" ? null : rest;
};

/** Messages retried per sync, on top of the history batch. */
const RETRY_BATCH = 25;

export const CURSOR_RESET_NOTE =
  "Inbox cursor expired and was reset. Replies and bounces that arrived during the gap were not synced.";

/**
 * Pulls new inbox mail for one mailbox and applies it message by message. The cursor moves only after
 * every message was handled, so a failure replays the batch. Handling is idempotent, so a replay is safe.
 */
export async function syncMailboxInbox(deps: InboxDeps, mailboxId: string): Promise<SyncOutcome> {
  const mailbox = await deps.store.getMailbox(mailboxId);
  if (!mailbox) return { kind: "skipped" };
  const counts: InboundCounts = {};
  try {
    const batch = await deps.provider.fetchInbound({ emailAddress: mailbox.emailAddress }, mailbox.cursor);
    // Retries first: the cursor moved past these, so only a fetch by id brings them back.
    const inBatch = new Set(batch.messages.map((m) => m.providerMessageId));
    const wanted = (await deps.store.loadRetryIds(mailbox, RETRY_BATCH)).filter((id) => !inBatch.has(id));
    const retried = wanted.length > 0 ? await deps.provider.fetchMessages({ emailAddress: mailbox.emailAddress }, wanted) : { messages: [], missing: [] };
    for (const id of retried.missing) await deps.store.recordMessageGone(mailbox, id, deps.clock.now());
    const messages = [...retried.messages, ...batch.messages];
    const failures = await deps.store.loadFailures(mailbox, messages.map((m) => m.providerMessageId));
    for (const email of messages) {
      const failure = failures.get(email.providerMessageId);
      if (failure?.deadLettered) continue;
      const classification = classifyInbound(mailbox.emailAddress, {
        from: email.from.email,
        subject: email.subject,
        bodyText: email.bodyText,
        headers: email.headers,
      });
      try {
        const outcome = await deps.store.applyInbound(mailbox, email, classification, deps.clock.now());
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        if (failure) await deps.store.clearMessageFailure(mailbox, email.providerMessageId, deps.clock.now());
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const state = await deps.store.recordMessageFailure(mailbox, email, reason, MAX_MESSAGE_ATTEMPTS, deps.clock.now());
        if (!state.deadLettered) throw new Error(`${reason} (message ${email.providerMessageId}, attempt ${state.attempts} of ${MAX_MESSAGE_ATTEMPTS})`);
        counts.dead_lettered = (counts.dead_lettered ?? 0) + 1;
      }
    }
    const reset = batch.reset === true;
    const now = deps.clock.now();
    const skipped = await deps.store.countDeadLetters(mailbox, new Date(now.getTime() - DEAD_LETTER_WINDOW_MS));
    const notes = [reset ? CURSOR_RESET_NOTE : null, skipped > 0 ? deadLetterNote(skipped) : null].filter((n) => n !== null);
    await deps.store.completeSync(mailbox.id, mailbox.cursor, batch.cursor, now, notes.length > 0 ? notes.join(" ") : null);
    return { kind: "synced", counts, reset };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.recordFailure(mailbox.id, message.slice(0, 500));
    return { kind: "failed", error: message, counts };
  }
}
