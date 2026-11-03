import type { MailboxProvider } from "@/contexts/outreach/email/application/ports";
import type { SentFinder } from "../application/reply-ports";

/** Looks in a mailbox's Sent folder for a reply by its Message-ID. It holds no way to send. */
export function createSentFinder(provider: () => MailboxProvider): SentFinder {
  return {
    async findSent(mailboxEmail, rfcMessageId, since, hint) {
      const found = await provider().findSent({ emailAddress: mailboxEmail }, rfcMessageId, since, hint);
      if (found.status !== "found") return found;
      return { status: "found", sent: { providerMessageId: found.sent.providerMessageId, providerThreadId: found.sent.providerThreadId } };
    },
  };
}
