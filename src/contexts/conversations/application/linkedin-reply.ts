import { aiIsOn, aiOffMessage, type AiStatus } from "@/contexts/integrations/domain/ai-status";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { REPLY_HELD_PAUSE_MINUTES, REPLY_OPERATION_GONE_HOURS, REPLY_OPERATION_TIMEOUT_MINUTES, REPLY_PAUSE_HOURS } from "../domain/linkedin-reply";
import { LinkedInReplyError, type LinkedInReplyAddress, type LinkedInReplyBlocker, type LinkedInReplyContext, type LinkedInReplyPanel, type LinkedInReplySender, type LinkedInReplyStore, type LinkedInSentFinder } from "./linkedin-reply-ports";
import type { AttemptRow } from "./reply-ports";

/**
 * Replies to a LinkedIn chat. Every message is typed or approved by a signed-in member, or sent as saved by an agent the
 * organization allows (docs/decisions.md, "Agent sends"). The ledger row exists before LinkedIn is called, and an
 * unknown outcome is never sent again on a guess. A person settles it.
 * Nothing here runs from a background job except `reconcileLinkedInReplies`, which only looks. Only
 * `sendLinkedInReply` takes `LinkedInReplySendDeps`; the rest get a port that looks at LinkedIn and cannot send.
 */
export interface LinkedInReplyDeps {
  store: LinkedInReplyStore;
  sender: LinkedInSentFinder;
  now: () => Date;
  /** Whether AI runs for the organization, so the panel can offer "Write a draft" or say what stops it. */
  aiStatus?: (organizationId: string) => Promise<AiStatus>;
}

/** `LinkedInReplyDeps` with a port that sends. Only `reply-send-composition.ts` builds one. */
export interface LinkedInReplySendDeps extends LinkedInReplyDeps {
  sender: LinkedInReplySender;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export type LinkedInReplyResult =
  | { status: "sent"; attemptId: string; replayed: boolean }
  | { status: "delivery_uncertain"; attemptId: string; replayed: boolean; error: string | null }
  | { status: "failed"; attemptId: string; replayed: boolean; error: string }
  | { status: "blocked"; attemptId: string; replayed: false; error: string; reason: LinkedInReplyBlocker }
  | { status: "in_progress"; attemptId: string; replayed: boolean };

function replay(attempt: AttemptRow): LinkedInReplyResult {
  switch (attempt.status) {
    case "sent":
    case "reconciled":
      return { status: "sent", attemptId: attempt.id, replayed: true };
    case "delivery_uncertain":
      return { status: "delivery_uncertain", attemptId: attempt.id, replayed: true, error: attempt.error };
    case "failed":
      return { status: "failed", attemptId: attempt.id, replayed: true, error: attempt.error ?? "The send failed." };
    default:
      return { status: "in_progress", attemptId: attempt.id, replayed: true };
  }
}

/** `aiOff` says what stops AI and how to turn it on, worded for the reader's role. Null when AI is on. */
export type LinkedInReplyPanelView = LinkedInReplyPanel & { canGenerate: boolean; aiOff: string | null };

export async function getLinkedInReplyPanel(deps: LinkedInReplyDeps, actor: Actor, threadId: string): Promise<LinkedInReplyPanelView | null> {
  if (!isUuid(threadId)) throw new NotFoundError("Conversation not found");
  const panel = await deps.store.panel(actor.organizationId, threadId, deps.now());
  if (!panel) return null;
  const status: AiStatus = deps.aiStatus ? await deps.aiStatus(actor.organizationId) : { state: "no_key" };
  return { ...panel, canGenerate: aiIsOn(status) && !panel.markedDone, aiOff: aiOffMessage(status, isOwnerOrAdmin(actor.role) ? "admin" : "member") };
}

export async function sendLinkedInReply(
  deps: LinkedInReplySendDeps,
  actor: Actor,
  threadId: string,
  input: { text?: string; idempotencyKey: string; draftId?: string; revision?: number },
): Promise<LinkedInReplyResult> {
  if (!isUuid(threadId)) throw new NotFoundError("Conversation not found");
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new ValidationError("An idempotency key of 8 to 200 characters is required.");
  // An agent sends a saved draft; a person types or edits the text they send.
  if (actor.via && input.draftId === undefined) throw new ValidationError("An agent sends a saved draft. Pass its draftId and revision.");
  if (!actor.via && input.text === undefined) throw new ValidationError("The reply cannot be empty.");
  if (input.draftId !== undefined) {
    if (!isUuid(input.draftId)) throw new NotFoundError("Draft not found");
    if (!Number.isInteger(input.revision) || (input.revision as number) < 1) throw new ValidationError("The draft revision is missing. Reload and try again.");
  }

  const now = deps.now();
  const begun = await deps.store.begin({
    organizationId: actor.organizationId,
    threadId,
    text: input.text,
    idempotencyKey: key,
    actorUserId: actor.userId,
    now,
    via: actor.via,
    ...(input.draftId !== undefined ? { draft: { id: input.draftId, revision: input.revision as number } } : {}),
  });
  if (begun.kind === "replay") return replay(begun.attempt);
  const send = begun.send;

  // Checked after the ledger row exists and right before the provider call.
  const blocker = await deps.store.checkBlockers(send, deps.now());
  if (blocker) {
    await deps.store.markFailed(send, blocker.message);
    return { status: "blocked", attemptId: send.attempt.id, replayed: false, error: blocker.message, reason: blocker.reason };
  }
  if (!(await deps.sender.available({ organizationId: send.organizationId, accountId: send.accountId }))) {
    // LinkedIn was disconnected between the claim and the call. Nothing went out.
    const text = "LinkedIn is not connected for this organization. The reply was not sent.";
    await deps.store.markFailed(send, text);
    return { status: "blocked", attemptId: send.attempt.id, replayed: false, error: text, reason: "not_connected" };
  }

  try {
    const sent = await deps.sender.send({ ...addressOf(send), text: send.text, sendKey: send.attempt.id, unlessRepliedAfter: send.draftWrittenAt });
    if ("operation" in sent) {
      await deps.store.markSubmitted(send, sent.operation);
      return { status: "in_progress", attemptId: send.attempt.id, replayed: false };
    }
    await deps.store.markSent(send, { providerMessageId: sent.messageId }, deps.now());
    return { status: "sent", attemptId: send.attempt.id, replayed: false };
  } catch (error) {
    if (error instanceof LinkedInReplyError && error.kind === "definite") {
      await applyRefusal(deps, send, error);
      return { status: "failed", attemptId: send.attempt.id, replayed: false, error: error.message };
    }
    // Timeout, dropped connection, 5xx or anything unexpected: it may have gone out. Never retried on a guess.
    await deps.store.markUncertain(send, message(error));
    return { status: "delivery_uncertain", attemptId: send.attempt.id, replayed: false, error: message(error) };
  }
}

async function applyRefusal(deps: LinkedInReplyDeps, send: LinkedInReplyContext, error: LinkedInReplyError): Promise<void> {
  if (error.code === "rate_limited") await deps.store.pauseAccount(send, new Date(deps.now().getTime() + (error.retryAfterMs ?? REPLY_PAUSE_HOURS * 3_600_000)));
  if (error.code === "auth") await deps.store.disconnectAccount(send, error.message);
  await deps.store.markFailed(send, error.message);
}

const addressOf = (send: LinkedInReplyContext): LinkedInReplyAddress => ({
  organizationId: send.organizationId,
  accountId: send.accountId,
  account: send.providerAccountId,
  chat: send.chat,
  member: send.member,
  slug: send.slug,
});

export interface LinkedInReplyReconcileReport {
  checked: number;
  found: number;
  uncertain: number;
  waiting: number;
}

export const LINKEDIN_RECONCILE_AFTER_MS = 10 * 60_000;
export const LINKEDIN_UNCERTAIN_AFTER_MS = 30 * 60_000;

/**
 * Looks in the chat for replies with no recorded outcome. Found: settled as delivered. Missing after 30 minutes: it
 * becomes (or stays) `delivery_uncertain` so a person decides. The same goes when LinkedIn cannot be checked, because a
 * `sending` attempt blocks the next send in its chat. A later check can still settle it. Nothing is resent.
 */
export async function reconcileLinkedInReplies(deps: LinkedInReplyDeps, limit = 25): Promise<LinkedInReplyReconcileReport> {
  const now = deps.now();
  const report: LinkedInReplyReconcileReport = { checked: 0, found: 0, uncertain: 0, waiting: 0 };
  await settleSubmittedReplies(deps, report, limit, now);
  for (const item of await deps.store.listUnsettled(new Date(now.getTime() - LINKEDIN_RECONCILE_AFTER_MS), limit)) {
    report.checked += 1;
    const { send } = item;
    const overdue = item.status === "sending" && now.getTime() - item.startedAt.getTime() >= LINKEDIN_UNCERTAIN_AFTER_MS;
    let found: { messageId: string | null } | null;
    try {
      if (!(await deps.sender.available({ organizationId: send.organizationId, accountId: send.accountId }))) throw new Error("LinkedIn is not connected");
      found = await deps.sender.findSent({ ...addressOf(send), text: send.text, since: new Date(item.startedAt.getTime() - 60_000), sendKey: send.attempt.id });
    } catch {
      if (overdue) {
        await deps.store.markUncertain(send, "The send never reported an outcome and LinkedIn could not be checked.");
        report.uncertain += 1;
      } else {
        await deps.store.noteChecked(send, now);
        report.waiting += 1;
      }
      continue;
    }
    if (found) {
      await deps.store.markSent(send, { providerMessageId: found.messageId }, now, "Found in the LinkedIn chat by its text.");
      report.found += 1;
    } else if (overdue) {
      await deps.store.markUncertain(send, "The send never reported an outcome and the message is not in the LinkedIn chat.");
      report.uncertain += 1;
    } else {
      await deps.store.noteChecked(send, now);
      report.waiting += 1;
    }
  }
  return report;
}

/**
 * Replies a vendor took and runs later. A finished read settles one the way a live answer would. Only a confirmed cancel lets
 * a draft go back, and a failed read waits: it says nothing about the send, and the person may be reading this draft.
 */
async function settleSubmittedReplies(deps: LinkedInReplyDeps, report: LinkedInReplyReconcileReport, limit: number, now: Date): Promise<void> {
  for (const { send, startedAt } of await deps.store.listSubmitted(limit)) {
    report.checked += 1;
    const where = { organizationId: send.organizationId, accountId: send.accountId, account: send.operation.account, operation: send.operation.id };
    const ageMinutes = (now.getTime() - startedAt.getTime()) / 60_000;
    await deps.store.noteRead(send, now);
    const read = await deps.sender.progress(where).catch(() => null);
    if (read?.state === "finished") {
      await deps.store.markSent(send, { providerMessageId: read.messageId }, now);
      report.found += 1;
      continue;
    }
    if (read?.state === "failed") {
      if (read.error.kind === "definite") await applyRefusal(deps, send, read.error);
      else await deps.store.markUncertain(send, read.error.message);
      continue;
    }
    if (!read) {
      if (ageMinutes >= REPLY_OPERATION_GONE_HOURS * 60) {
        await deps.store.markUncertain(send, "The LinkedIn provider stopped answering about this send, so it may or may not have gone out.");
        report.uncertain += 1;
      } else report.waiting += 1;
      continue;
    }
    const blocker = await deps.store.checkBlockers(send, now);
    // Only the person's own block stops a send already on its way. A pause or a lost connection is the vendor's to report.
    const stop = blocker && blocker.reason !== "not_connected" && blocker.reason !== "paused" ? blocker.message : read.held ? "The LinkedIn provider held this reply for the account's working hours, so it was stopped. The reply was not sent." : ageMinutes >= REPLY_OPERATION_TIMEOUT_MINUTES ? "timeout" : null;
    if (!stop) {
      report.waiting += 1;
      continue;
    }
    const answer = await deps.sender.cancel(where).catch(() => null);
    if (answer !== "cancelled") {
      // Still running, or too late to stop: the next read has the outcome.
      report.waiting += 1;
      continue;
    }
    if (stop === "timeout") {
      await deps.store.markUncertain(send, "The LinkedIn provider did not finish this send in time, and it was stopped. It may have gone out.");
      report.uncertain += 1;
    } else {
      if (read.held) await deps.store.pauseAccount(send, new Date(now.getTime() + REPLY_HELD_PAUSE_MINUTES * 60_000));
      await deps.store.markFailed(send, stop);
    }
  }
}
