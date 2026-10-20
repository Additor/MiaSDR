import { ValidationError } from "@/shared/errors";
import type { InboundConversationStore, InboundEmailInput, IngestOutcome, QuarantineInbound } from "./ports";

export interface IngestDeps {
  store: InboundConversationStore;
  quarantine: QuarantineInbound;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;
const EMPTY_BODY = "(no text content)";

/**
 * Files one received email under its sender: finds or creates the person (source `inbound`, an existing
 * person is never changed), their record in the default pipeline, the conversation for the mail thread
 * and the message. Running it twice for the same provider message stores it once.
 *
 * A message whose sender address is unusable cannot be tied to anyone. It is parked as an identity
 * exception (never dropped) and a reviewer files it under a person later. A reviewer's replay names the
 * person, so it skips the address check.
 */
export async function ingestInboundEmail(deps: IngestDeps, input: InboundEmailInput): Promise<IngestOutcome> {
  const email = input.from.email.trim().toLowerCase();
  const mailbox = input.accountRef.trim().toLowerCase();
  if (mailbox === "" || input.providerMessageId.trim() === "") throw new ValidationError("An inbound message needs a mailbox and a provider message id.");

  const normalized: InboundEmailInput = {
    ...input,
    accountRef: mailbox,
    // A message with no thread id starts its own thread.
    providerThreadId: input.providerThreadId.trim() || input.providerMessageId,
    from: { email, name: input.from.name?.trim() || null },
    subject: input.subject.trim(),
    bodyText: input.bodyText.trim() === "" ? EMPTY_BODY : input.bodyText,
  };

  if (!input.personId && !EMAIL.test(email)) {
    const reason = `Inbound message ${input.providerMessageId} has no usable sender address.`;
    const parked = await deps.quarantine({
      organizationId: input.organizationId,
      sourceEventKey: `gmail:${mailbox}:${input.providerMessageId}`,
      identityValue: email || null,
      reason,
      payload: {
        kind: "email",
        message: {
          accountRef: mailbox,
          providerThreadId: normalized.providerThreadId,
          providerMessageId: input.providerMessageId,
          rfcMessageId: input.rfcMessageId,
          inReplyTo: input.inReplyTo,
          from: normalized.from,
          to: input.to,
          cc: input.cc ?? [],
          subject: normalized.subject,
          bodyText: normalized.bodyText,
          receivedAt: input.receivedAt.toISOString(),
          autoReply: input.autoReply,
          ...(input.possibleBounce ? { possibleBounce: true } : {}),
        },
      },
    });
    return { status: "quarantined", exceptionId: parked.id, reason };
  }

  return deps.store.ingestEmail(normalized);
}
