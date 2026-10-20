import { ValidationError } from "@/shared/errors";
import type { InboundLinkedInInput, InboundLinkedInStore } from "./linkedin-ports";
import type { IngestOutcome, QuarantineInbound } from "./ports";

export interface IngestLinkedInDeps {
  store: InboundLinkedInStore;
  quarantine: QuarantineInbound;
}

const EMPTY_BODY = "(no text content)";

/**
 * Files one received LinkedIn message under its sender: the lead it belongs to (or a new person with
 * source `inbound`), their record in the default pipeline, the conversation for the chat and the
 * message. Running it twice for the same provider message stores it once. Messages the account owner
 * wrote are not inbound and must not reach this use case.
 *
 * A message from a new chat whose sender has no profile slug and matches no known lead cannot be tied
 * to a person. The store reports it unresolved, and it is parked as an identity exception (never
 * dropped) for a reviewer to file under a person.
 */
export async function ingestInboundLinkedIn(deps: IngestLinkedInDeps, input: InboundLinkedInInput): Promise<IngestOutcome> {
  const account = input.accountRef.trim();
  const messageId = input.providerMessageId.trim();
  const chat = input.providerThreadId.trim();
  const member = input.counterparty.providerId.trim();
  if (account === "" || messageId === "") throw new ValidationError("An inbound LinkedIn message needs an account and a provider message id.");
  if (chat === "") throw new ValidationError(`LinkedIn message ${messageId} has no chat id.`);
  if (member === "") throw new ValidationError(`LinkedIn message ${messageId} has no sender.`);

  const normalized: InboundLinkedInInput = {
    ...input,
    accountRef: account,
    accountName: input.accountName?.trim() || null,
    providerThreadId: chat,
    providerMessageId: messageId,
    counterparty: { providerId: member, name: input.counterparty.name?.trim() || null, profileUrl: input.counterparty.profileUrl?.trim() || null, slug: input.counterparty.slug?.trim().toLowerCase() || null },
    bodyText: input.bodyText.trim() === "" ? EMPTY_BODY : input.bodyText,
  };
  const result = await deps.store.ingestLinkedIn(normalized);
  if (result.status !== "unresolved") return result;

  const parked = await deps.quarantine({
    organizationId: input.organizationId,
    sourceEventKey: `linkedin:${account}:${messageId}`,
    identityValue: result.identityValue,
    reason: result.reason,
    payload: {
      kind: "linkedin",
      message: {
        accountRef: account,
        accountName: normalized.accountName,
        providerThreadId: chat,
        providerMessageId: messageId,
        counterparty: normalized.counterparty,
        bodyText: normalized.bodyText,
        receivedAt: input.receivedAt.toISOString(),
      },
    },
  });
  return { status: "quarantined", exceptionId: parked.id, reason: result.reason };
}
