import { ProviderSendError, type InboundBatch, type InboundEmail, type MailboxProvider, type OutgoingEmail, type SentEmail, type FindSentResult } from "../../application/ports";

export type FakeBehavior =
  /** The message is accepted. */
  | "ok"
  /** The provider refuses; nothing is sent. */
  | "refuse"
  /** The call fails with a timeout, but the message was in fact accepted. */
  | "timeout-after-accept"
  /** The call fails with a timeout and the message was not accepted. */
  | "timeout-lost";

/** In-memory mailbox for tests and local runs. Behavior is chosen per recipient or globally. */
export class FakeMailboxProvider implements MailboxProvider {
  readonly delivered: OutgoingEmail[] = [];
  private readonly sentIndex = new Map<string, SentEmail>();
  private counter = 0;
  /** Real providers never reuse ids, and the database enforces it. */
  private readonly instance = Math.random().toString(36).slice(2, 10);
  behavior: (email: OutgoingEmail) => FakeBehavior = () => "ok";
  /** When true, `findSent` throws, like a mailbox API outage. */
  findFails = false;
  /** When set, `findSent` cannot prove absence and returns this reason for a message it does not hold. */
  findInconclusive: string | null = null;

  /** Addresses `verify` rejects, to exercise the failure path. */
  readonly unverifiable = new Set<string>();

  async verify(emailAddress: string): Promise<void> {
    if (this.unverifiable.has(emailAddress)) throw new Error("The service account is not allowed to act as this address.");
  }

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const behavior = this.behavior(email);
    if (behavior === "refuse") throw new ProviderSendError("Recipient address rejected", "definite");
    if (behavior === "timeout-lost") throw new ProviderSendError("Request timed out", "unknown");
    const sent = { providerMessageId: `fake-${this.instance}-${++this.counter}`, threadId: email.threadId ?? `thread-${this.instance}-${this.counter}` };
    this.delivered.push(email);
    this.sentIndex.set(email.rfcMessageId, sent);
    if (behavior === "timeout-after-accept") throw new ProviderSendError("Request timed out", "unknown");
    return sent;
  }

  async findSent(_mailbox: { emailAddress: string }, rfcMessageId: string): Promise<FindSentResult> {
    if (this.findFails) throw new Error("Mailbox API unavailable");
    const sent = this.sentIndex.get(rfcMessageId);
    if (sent) return { status: "found", sent };
    return this.findInconclusive ? { status: "inconclusive", reason: this.findInconclusive } : { status: "absent" };
  }

  /** When true, the next `fetchInbound` with a cursor acts like an expired Gmail history id. */
  cursorExpired = false;
  /** When true, `fetchInbound` throws, like a mailbox API outage. */
  inboundFails = false;
  private readonly inboxes = new Map<string, Array<{ seq: number; email: InboundEmail }>>();
  private inboundSeq = 0;
  private inboundCounter = 0;

  /** Puts a message in a mailbox's inbox and advances the mailbox cursor. Missing fields get defaults. */
  deliverInbound(mailboxAddress: string, partial: Partial<InboundEmail> = {}): InboundEmail {
    const n = ++this.inboundCounter;
    const email: InboundEmail = {
      providerMessageId: `fake-in-${this.instance}-${n}`,
      threadId: `fake-in-thread-${this.instance}-${n}`,
      rfcMessageId: `<in-${this.instance}-${n}@example.com>`,
      inReplyTo: null,
      references: [],
      from: { email: "lead@example.com", name: null },
      to: [mailboxAddress],
      cc: [],
      subject: "Re: hello",
      bodyText: "Thanks",
      receivedAt: new Date(),
      headers: {},
      sendId: null,
      ...partial,
    };
    const inbox = this.inboxes.get(mailboxAddress) ?? [];
    inbox.push({ seq: ++this.inboundSeq, email });
    this.inboxes.set(mailboxAddress, inbox);
    return email;
  }

  async fetchInbound(mailbox: { emailAddress: string }, cursor: string | null): Promise<InboundBatch & { reset?: boolean }> {
    if (this.inboundFails) throw new Error("Mailbox API unavailable");
    const current = String(this.inboundSeq);
    if (cursor === null) return { messages: [], cursor: current };
    if (this.cursorExpired) return { messages: [], cursor: current, reset: true };
    const after = Number(cursor);
    const messages = (this.inboxes.get(mailbox.emailAddress) ?? []).filter((m) => m.seq > after).map((m) => m.email);
    return { messages, cursor: current };
  }

  async fetchMessages(mailbox: { emailAddress: string }, providerMessageIds: string[]): Promise<{ messages: InboundEmail[]; missing: string[] }> {
    if (this.inboundFails) throw new Error("Mailbox API unavailable");
    const held = new Map((this.inboxes.get(mailbox.emailAddress) ?? []).map((m) => [m.email.providerMessageId, m.email]));
    const messages: InboundEmail[] = [];
    const missing: string[] = [];
    for (const id of providerMessageIds) {
      const email = held.get(id);
      if (email) messages.push(email);
      else missing.push(id);
    }
    return { messages, missing };
  }
}
