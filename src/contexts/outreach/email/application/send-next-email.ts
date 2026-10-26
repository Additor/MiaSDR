import { isOutboundPaused } from "@/shared/outbound-pause";
import { randomUUID } from "node:crypto";
import { renderEmail } from "../../domain/render";
import { MAX_SEND_ATTEMPTS, NOT_FOUND_GRACE_MINUTES, UNCERTAIN_AFTER_MINUTES, pickGapMinutes, retryDelayMinutes, emailRules } from "../../domain/send-policy";
import { resolveThreading } from "../domain/threading";
import { unsubscribeLinks } from "../domain/unsubscribe-token";
import { defaultWorkingHours } from "../../domain/working-hours";
import type { MailboxDomainPolicy } from "./mailbox-management";
import { ProviderSendError, type Clock, type MailboxProvider, type OutreachStore, type SendClaim } from "./ports";

export interface EngineDeps {
  store: OutreachStore;
  provider: MailboxProvider;
  clock: Clock;
  random: () => number;
  appUrl: string;
  unsubscribeSecret: string;
  /** MAILBOX_ALLOWED_DOMAINS policy, re-checked at claim time. */
  domainPolicy?: MailboxDomainPolicy;
}

export type SendOutcome =
  | { kind: "idle" }
  | { kind: "sent"; sendId: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; retry: boolean }
  | { kind: "unknown" };

/** Domain-friendly default zone; organizations override through their settings. */
const FALLBACK_ZONE = "UTC";

/** Claims and delivers at most one email for one mailbox. */
export async function sendNextEmail(deps: EngineDeps, mailboxId: string): Promise<SendOutcome> {
  // PAUSE_OUTBOUND is read per call: while set, nothing is claimed.
  if (isOutboundPaused()) return { kind: "idle" };
  const now = deps.clock.now();
  const claim = await deps.store.claimNext({
    mailboxId,
    now,
    pickGapMinutes: (stored) => pickGapMinutes(emailRules(stored).sendGapMinutes, deps.random),
    takeoverAfterHours: (stored) => emailRules(stored).takeoverAfterHours,
    defaultWorkingHours: (zone) => defaultWorkingHours(zone ?? FALLBACK_ZONE),
    domainPolicy: deps.domainPolicy,
  });
  if (!claim) return { kind: "idle" };
  return deliver(deps, claim);
}

async function deliver(deps: EngineDeps, claim: SendClaim): Promise<SendOutcome> {
  // The claim is durable. From here every path ends the claim in a known state.
  const blocked = await deps.store.checkBlockers(claim);
  if (blocked) {
    await deps.store.abandon(claim, blocked, deps.clock.now());
    return { kind: "blocked", reason: blocked };
  }

  const { pageUrl: unsubscribeUrl, oneClickUrl } = unsubscribeLinks(deps.appUrl, deps.unsubscribeSecret, claim.organizationId, claim.person.email);
  const rendered = renderEmail({
    subjectTemplate: claim.step.subject,
    bodyTemplate: claim.step.body,
    variables: claim.person.variables,
    signatureHtml: claim.mailbox.signatureHtml,
    unsubscribeUrl,
    random: deps.random,
  });
  const threading = resolveThreading(rendered.subject, claim.priorSent);
  if (threading.subject.trim() === "") {
    // Nothing to thread onto and nothing to say: a blank subject would reach the lead. Fail this lead, send nothing.
    const message = `Subject is empty for this lead (step ${claim.stepNumber}). Check the merge fields in the subject.`;
    await deps.store.markFailed(claim, message, deps.clock.now(), 0, claim.attempt);
    return { kind: "failed", retry: false };
  }
  const rfcMessageId = `<${randomUUID()}@${claim.mailbox.emailAddress.split("@")[1] ?? "miasdr.local"}>`;

  // Stored before the provider call: if we crash right after it, reconciliation can find the message by this id.
  await deps.store.recordRendered(claim, { subject: threading.subject, body: rendered.bodyText, rfcMessageId });

  try {
    const sent = await deps.provider.send({
      mailbox: { emailAddress: claim.mailbox.emailAddress, displayName: claim.mailbox.displayName },
      to: claim.person.email,
      subject: threading.subject,
      bodyText: rendered.bodyText,
      bodyHtml: rendered.bodyHtml,
      rfcMessageId,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      threadId: threading.threadId,
      listUnsubscribeUrl: oneClickUrl,
    });
    await deps.store.markSent(claim, sent, deps.clock.now());
    return { kind: "sent", sendId: claim.sendId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderSendError && error.kind === "definite") {
      await deps.store.markFailed(claim, message, deps.clock.now(), retryDelayMinutes(claim.attempt), MAX_SEND_ATTEMPTS);
      return { kind: "failed", retry: claim.attempt < MAX_SEND_ATTEMPTS };
    }
    // Anything else might have gone out. Never retry on a guess.
    await deps.store.markUnknown(claim, message);
    return { kind: "unknown" };
  }
}

export interface ReconcileReport {
  checked: number;
  foundSent: number;
  retryable: number;
  stillWaiting: number;
  /** Sends the mailbox could not prove sent or unsent. They stay `unknown` and are never retried. */
  inconclusive: number;
}

/** Looks up sends whose outcome is unknown and settles them from what the mailbox actually holds. */
export async function reconcileUncertainSends(deps: EngineDeps, limit = 25): Promise<ReconcileReport> {
  const now = deps.clock.now();
  const report: ReconcileReport = { checked: 0, foundSent: 0, retryable: 0, stillWaiting: 0, inconclusive: 0 };
  const olderThan = new Date(now.getTime() - UNCERTAIN_AFTER_MINUTES * 60_000);

  for (const send of await deps.store.listUncertain(olderThan, limit)) {
    report.checked += 1;
    if (!send.rfcMessageId) {
      // Crashed before the message was rendered: nothing can have been sent.
      await deps.store.resolveUncertainAsNotSent(send, now, retryDelayMinutes(send.attempt), MAX_SEND_ATTEMPTS);
      report.retryable += 1;
      continue;
    }
    let found;
    try {
      found = await deps.provider.findSent({ emailAddress: send.mailboxEmail }, send.rfcMessageId, send.claimedAt, send.recipientEmail ? { to: send.recipientEmail } : undefined);
    } catch {
      report.stillWaiting += 1;
      continue;
    }
    if (found.status === "found") {
      await deps.store.resolveUncertainAsSent(send, found.sent, now);
      report.foundSent += 1;
    } else if (found.status === "inconclusive") {
      // No proof either way. Leave the send `unknown` so it is never retried on a guess.
      console.warn(`email reconcile: send ${send.sendId} stays unknown: ${found.reason}`);
      report.inconclusive += 1;
    } else if (now.getTime() - send.claimedAt.getTime() >= NOT_FOUND_GRACE_MINUTES * 60_000) {
      await deps.store.resolveUncertainAsNotSent(send, now, retryDelayMinutes(send.attempt), MAX_SEND_ATTEMPTS);
      report.retryable += 1;
    } else {
      report.stillWaiting += 1;
    }
  }
  return report;
}
