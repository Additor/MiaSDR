import { randomUUID } from "node:crypto";
import { normalizeEmail } from "@/contexts/people/domain/normalize";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { isOutboundPaused } from "@/shared/outbound-pause";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { renderEmail } from "../../domain/render";
import { NOT_FOUND_GRACE_MINUTES, UNCERTAIN_AFTER_MINUTES } from "../../domain/send-policy";
import { TEST_BODY_TEMPLATE, TEST_SEND_IN_FLIGHT_MINUTES, TEST_SEND_LIMIT, TEST_SEND_WINDOW_MINUTES, TEST_SUBJECT_TEMPLATE, minutesUntilTestSlot } from "../domain/test-send";
import { unsubscribeLinks } from "../domain/unsubscribe-token";
import type { MailboxDomainPolicy } from "./mailbox-management";
import { ProviderSendError, type Clock, type MailboxProvider, type SentEmail } from "./ports";

export type TestClaim =
  | {
      kind: "claimed";
      sendId: string;
      organizationId: string;
      to: string;
      mailbox: { id: string; emailAddress: string; displayName: string | null; signatureHtml: string | null };
    }
  | { kind: "not_found" }
  | { kind: "blocked"; reason: "mailbox_not_connected" | "domain_policy" | "suppressed" | "do_not_contact" | "in_flight"; detail?: string }
  | { kind: "rate_limited"; oldestClaimedAt: Date };

export interface UncertainTestSend {
  sendId: string;
  organizationId: string;
  mailboxEmail: string;
  to: string;
  claimedAt: Date;
  rfcMessageId: string | null;
}

/**
 * Persistence for mailbox test sends. A test send is a `sends` row with kind `test`: the claim runs under the same
 * mailbox row lock as a campaign claim, so a test send and a campaign send never race for the same mailbox.
 */
export interface TestSendStore {
  /** One transaction: lock the mailbox, run the checks, insert the claim. Never inserts when a check fails. */
  claim(input: {
    organizationId: string;
    mailboxId: string;
    to: string;
    requestedBy: string;
    now: Date;
    domainPolicy: MailboxDomainPolicy;
    limit: number;
    windowMinutes: number;
    inFlightMinutes: number;
  }): Promise<TestClaim>;
  recordRendered(sendId: string, rendered: { subject: string; body: string; rfcMessageId: string }): Promise<void>;
  /** Re-checks suppression and do-not-contact right before the provider call. */
  recipientBlock(organizationId: string, to: string): Promise<"suppressed" | "do_not_contact" | null>;
  /** Releases a claim that never reached the provider. */
  abandon(sendId: string, reason: string): Promise<void>;
  markSent(sendId: string, sent: SentEmail, now: Date): Promise<void>;
  markFailed(sendId: string, error: string): Promise<void>;
  markUnknown(sendId: string, error: string): Promise<void>;
  audit(entry: { organizationId: string; actorUserId: string; sendId: string; mailboxId: string; to: string; status: string }): Promise<void>;
  listUncertain(olderThan: Date, limit: number): Promise<UncertainTestSend[]>;
  /** Only rows still `sending` or `unknown` change. */
  settle(sendId: string, outcome: { status: "sent"; sent: SentEmail; now: Date } | { status: "failed"; error: string }): Promise<void>;
}

export interface TestSendDeps {
  store: TestSendStore;
  provider: MailboxProvider;
  clock: Clock;
  appUrl: string;
  unsubscribeSecret: string;
  domainPolicy: MailboxDomainPolicy;
}

export type TestSendResult =
  | { status: "sent"; sendId: string; message: string }
  | { status: "failed"; sendId: string; message: string }
  | { status: "unknown"; sendId: string; message: string }
  | { status: "blocked"; message: string }
  | { status: "rate_limited"; message: string; retryAfterMinutes: number };

const BLOCK_TEXT: Record<Extract<TestClaim, { kind: "blocked" }>["reason"], string> = {
  mailbox_not_connected: "This mailbox is not connected. Run Test connection first.",
  domain_policy: "This mailbox is outside the allowed mailbox domains, so it cannot send.",
  suppressed: "That address is on the suppression list, so no test email was sent.",
  do_not_contact: "That address belongs to a lead marked do not contact, so no test email was sent.",
  in_flight: "A test email from this mailbox is already being sent. Wait for it to finish.",
};

/**
 * Sends one test email from a mailbox. Goes through the same claim, domain policy and blocker checks as a
 * campaign send, and never retries an outcome it cannot prove.
 */
export async function sendTestEmail(deps: TestSendDeps, actor: Actor, mailboxId: string, input: { to: string }): Promise<TestSendResult> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can send a test email.");
  if (isOutboundPaused()) throw new ConflictError("Sending is paused, so no test email was sent. The server administrator ends the pause, see docs/operations.md.");
  const to = normalizeEmail(input.to);
  if (!to) throw new ValidationError("Enter a valid recipient address.");

  const now = deps.clock.now();
  const claim = await deps.store.claim({
    organizationId: actor.organizationId,
    mailboxId,
    to,
    requestedBy: actor.userId,
    now,
    domainPolicy: deps.domainPolicy,
    limit: TEST_SEND_LIMIT,
    windowMinutes: TEST_SEND_WINDOW_MINUTES,
    inFlightMinutes: TEST_SEND_IN_FLIGHT_MINUTES,
  });
  if (claim.kind === "not_found") throw new NotFoundError("Mailbox not found");
  if (claim.kind === "blocked") return { status: "blocked", message: claim.detail ?? BLOCK_TEXT[claim.reason] };
  if (claim.kind === "rate_limited") {
    const retryAfterMinutes = minutesUntilTestSlot(claim.oldestClaimedAt, now);
    return {
      status: "rate_limited",
      retryAfterMinutes,
      message: `A mailbox can send ${TEST_SEND_LIMIT} test emails per hour. Try again in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`,
    };
  }

  // The claim is durable. From here every path ends it in a known state.
  const blocked = await deps.store.recipientBlock(claim.organizationId, claim.to);
  if (blocked) {
    await deps.store.abandon(claim.sendId, blocked);
    return { status: "blocked", message: BLOCK_TEXT[blocked] };
  }

  const { pageUrl: unsubscribeUrl, oneClickUrl } = unsubscribeLinks(deps.appUrl, deps.unsubscribeSecret, claim.organizationId, claim.to);
  const rendered = renderEmail({
    subjectTemplate: TEST_SUBJECT_TEMPLATE,
    bodyTemplate: TEST_BODY_TEMPLATE,
    variables: { mailbox: claim.mailbox.emailAddress, sentAt: now.toISOString().slice(0, 16).replace("T", " ") },
    signatureHtml: claim.mailbox.signatureHtml,
    unsubscribeUrl,
    random: () => 0,
  });
  const rfcMessageId = `<${randomUUID()}@${claim.mailbox.emailAddress.split("@")[1] ?? "miasdr.local"}>`;
  await deps.store.recordRendered(claim.sendId, { subject: rendered.subject, body: rendered.bodyText, rfcMessageId });

  const audit = (status: string) =>
    deps.store.audit({ organizationId: claim.organizationId, actorUserId: actor.userId, sendId: claim.sendId, mailboxId: claim.mailbox.id, to: claim.to, status });

  try {
    const sent = await deps.provider.send({
      mailbox: { emailAddress: claim.mailbox.emailAddress, displayName: claim.mailbox.displayName },
      to: claim.to,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      bodyHtml: rendered.bodyHtml,
      rfcMessageId,
      inReplyTo: null,
      references: [],
      threadId: null,
      listUnsubscribeUrl: oneClickUrl,
    });
    await deps.store.markSent(claim.sendId, sent, deps.clock.now());
    await audit("sent");
    return { status: "sent", sendId: claim.sendId, message: `Test email sent to ${claim.to}. Check that inbox.` };
  } catch (error) {
    const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (isDefiniteRefusal(error)) {
      await deps.store.markFailed(claim.sendId, text);
      await audit("failed");
      return { status: "failed", sendId: claim.sendId, message: `The mail provider refused the test email: ${text}` };
    }
    // Anything else might have gone out. Never retried on a guess.
    await deps.store.markUnknown(claim.sendId, text);
    await audit("unknown");
    return {
      status: "unknown",
      sendId: claim.sendId,
      message: "The provider did not confirm the test email. It may still arrive. MiaSDR checks the mailbox's Sent folder and settles it; do not send another until then.",
    };
  }
}

/** The `kind` check also covers an error built by another copy of the module, which a bundler can make per route. */
function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof ProviderSendError ? error.kind === "definite" : error instanceof Error && (error as { kind?: unknown }).kind === "definite";
}

export interface TestReconcileReport {
  checked: number;
  foundSent: number;
  notSent: number;
  waiting: number;
}

/** Settles test sends with no recorded outcome from what the mailbox holds. A test send is never retried. */
export async function reconcileTestSends(deps: Pick<TestSendDeps, "store" | "provider" | "clock">, limit = 25): Promise<TestReconcileReport> {
  const now = deps.clock.now();
  const report: TestReconcileReport = { checked: 0, foundSent: 0, notSent: 0, waiting: 0 };
  const olderThan = new Date(now.getTime() - UNCERTAIN_AFTER_MINUTES * 60_000);
  for (const send of await deps.store.listUncertain(olderThan, limit)) {
    report.checked += 1;
    if (!send.rfcMessageId) {
      // Crashed before the message was rendered: nothing can have been sent.
      await deps.store.settle(send.sendId, { status: "failed", error: "The send stopped before the message was built. Nothing was sent." });
      report.notSent += 1;
      continue;
    }
    let found;
    try {
      found = await deps.provider.findSent({ emailAddress: send.mailboxEmail }, send.rfcMessageId, send.claimedAt, { to: send.to });
    } catch {
      report.waiting += 1;
      continue;
    }
    if (found.status === "found") {
      await deps.store.settle(send.sendId, { status: "sent", sent: found.sent, now });
      report.foundSent += 1;
    } else if (found.status === "absent" && now.getTime() - send.claimedAt.getTime() >= NOT_FOUND_GRACE_MINUTES * 60_000) {
      await deps.store.settle(send.sendId, { status: "failed", error: "Not found in the mailbox after the grace period." });
      report.notSent += 1;
    } else {
      report.waiting += 1;
    }
  }
  return report;
}
