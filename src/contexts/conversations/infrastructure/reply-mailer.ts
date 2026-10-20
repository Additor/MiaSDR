import { env } from "@/shared/env";
import { unsubscribeLinks } from "@/contexts/outreach/email/domain/unsubscribe-token";
import { applySignature, toHtmlBody } from "@/contexts/outreach/domain/render";
import { ProviderSendError, type MailboxProvider } from "@/contexts/outreach/application/ports";
import { ReplySendError, type ReplyMailer } from "../application/reply-ports";

/**
 * Sends a reply through the same MailboxProvider and message path as campaign mail: our own Message-ID
 * (also copied into X-MiaSDR-Send-Id by the Gmail adapter), In-Reply-To and References, the Gmail thread id.
 * Only the draft's text goes out, plus the mailbox signature. There is no unsubscribe footer in a reply,
 * but the List-Unsubscribe header stays, so a mail client's unsubscribe button still works.
 */
export function createReplyMailer(provider: () => MailboxProvider): ReplyMailer {
  return {
    async send(request) {
      const { MAILBOX_PROVIDER, APP_URL, UNSUBSCRIBE_SECRET } = env();
      if (!MAILBOX_PROVIDER) throw new ReplySendError("No mail provider is configured, so nothing was sent.", "definite");
      const body = applySignature(request.bodyText, request.mailbox.signatureHtml);
      const { oneClickUrl } = unsubscribeLinks(APP_URL, UNSUBSCRIBE_SECRET, request.organizationId, request.to);
      try {
        const sent = await provider().send({
          mailbox: { emailAddress: request.mailbox.emailAddress, displayName: request.mailbox.displayName },
          to: request.to,
          ...(request.cc.length > 0 ? { cc: request.cc } : {}),
          subject: request.subject,
          bodyText: body,
          bodyHtml: toHtmlBody(body),
          rfcMessageId: request.rfcMessageId,
          inReplyTo: request.inReplyTo,
          references: request.references,
          threadId: request.threadId,
          listUnsubscribeUrl: oneClickUrl,
        });
        return { providerMessageId: sent.providerMessageId, threadId: sent.threadId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ReplySendError(message, error instanceof ProviderSendError && error.kind === "definite" ? "definite" : "unknown");
      }
    },
    async findSent(mailboxEmail, rfcMessageId, since, hint) {
      const found = await provider().findSent({ emailAddress: mailboxEmail }, rfcMessageId, since, hint);
      if (found.status !== "found") return found;
      return { status: "found", sent: { providerMessageId: found.sent.providerMessageId, threadId: found.sent.threadId } };
    },
  };
}
