import { aiIsOn, aiOffMessage, type AiStatus } from "@/contexts/integrations/domain/ai-status";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { REPLY_PAUSE_HOURS } from "../domain/linkedin-reply";
import { LinkedInReplyError, type LinkedInReplyPanel, type LinkedInReplySender, type LinkedInReplyStore } from "./linkedin-reply-ports";
import type { AttemptRow } from "./reply-ports";

/**
 * Replies to a LinkedIn chat from the inbox. Every message is typed or approved by a signed-in member, the ledger row
 * exists before LinkedIn is called, and an unknown outcome is never sent again on a guess. A person settles it.
 * Nothing here runs from a background job except `reconcileLinkedInReplies`, which only looks.
 */
export interface LinkedInReplyDeps {
  store: LinkedInReplyStore;
  sender: LinkedInReplySender;
  now: () => Date;
  /** Whether AI runs for the organization, so the panel can offer "Write a draft" or say what stops it. */
  aiStatus?: (organizationId: string) => Promise<AiStatus>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export type LinkedInReplyResult =
  | { status: "sent"; attemptId: string; replayed: boolean }
  | { status: "delivery_uncertain"; attemptId: string; replayed: boolean; error: string | null }
  | { status: "failed"; attemptId: string; replayed: boolean; error: string }
  | { status: "blocked"; attemptId: string; replayed: false; error: string }
  | { status: "in_progress"; attemptId: string; replayed: true };

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

export async function getLinkedInReplyPanel(deps: LinkedInReplyDeps, actor: Actor, conversationId: string): Promise<LinkedInReplyPanelView | null> {
  if (!isUuid(conversationId)) throw new NotFoundError("Conversation not found");
  const panel = await deps.store.panel(actor.organizationId, conversationId, deps.now());
  if (!panel) return null;
  const status: AiStatus = deps.aiStatus ? await deps.aiStatus(actor.organizationId) : { state: "no_key" };
  return { ...panel, canGenerate: aiIsOn(status) && !panel.markedDone, aiOff: aiOffMessage(status, isOwnerOrAdmin(actor.role) ? "admin" : "member") };
}

export async function sendLinkedInReply(
  deps: LinkedInReplyDeps,
  actor: Actor,
  conversationId: string,
  input: { text: string; idempotencyKey: string; draftId?: string; revision?: number },
): Promise<LinkedInReplyResult> {
  if (!isUuid(conversationId)) throw new NotFoundError("Conversation not found");
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new ValidationError("An idempotency key of 8 to 200 characters is required.");
  if (input.draftId !== undefined) {
    if (!isUuid(input.draftId)) throw new NotFoundError("Draft not found");
    if (!Number.isInteger(input.revision) || (input.revision as number) < 1) throw new ValidationError("The draft revision is missing. Reload and try again.");
  }

  const now = deps.now();
  const begun = await deps.store.begin({
    organizationId: actor.organizationId,
    conversationId,
    text: input.text,
    idempotencyKey: key,
    actorUserId: actor.userId,
    now,
    ...(input.draftId !== undefined ? { draft: { id: input.draftId, revision: input.revision as number } } : {}),
  });
  if (begun.kind === "replay") return replay(begun.attempt);
  const send = begun.send;

  // Checked after the ledger row exists and right before the provider call.
  const blocker = await deps.store.checkBlockers(send, deps.now());
  if (blocker) {
    await deps.store.markFailed(send, blocker.message);
    return { status: "blocked", attemptId: send.attempt.id, replayed: false, error: blocker.message };
  }
  if (!(await deps.sender.available(send.organizationId))) {
    // LinkedIn was disconnected between the claim and the call. Nothing went out.
    const text = "LinkedIn is not connected for this organization. The reply was not sent.";
    await deps.store.markFailed(send, text);
    return { status: "blocked", attemptId: send.attempt.id, replayed: false, error: text };
  }

  try {
    const sent = await deps.sender.send({ organizationId: send.organizationId, account: send.providerAccountId, chat: send.chat, text: send.text });
    await deps.store.markSent(send, { providerMessageId: sent.messageId }, deps.now());
    return { status: "sent", attemptId: send.attempt.id, replayed: false };
  } catch (error) {
    if (error instanceof LinkedInReplyError && error.kind === "definite") {
      if (error.code === "rate_limited") await deps.store.pauseAccount(send, new Date(deps.now().getTime() + REPLY_PAUSE_HOURS * 3_600_000));
      if (error.code === "auth") await deps.store.disconnectAccount(send, error.message);
      await deps.store.markFailed(send, error.message);
      return { status: "failed", attemptId: send.attempt.id, replayed: false, error: error.message };
    }
    // Timeout, dropped connection, 5xx or anything unexpected: it may have gone out. Never retried on a guess.
    await deps.store.markUncertain(send, message(error));
    return { status: "delivery_uncertain", attemptId: send.attempt.id, replayed: false, error: message(error) };
  }
}

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
 * becomes (or stays) `delivery_uncertain` so a person decides. Nothing is resent.
 */
export async function reconcileLinkedInReplies(deps: LinkedInReplyDeps, limit = 25): Promise<LinkedInReplyReconcileReport> {
  const now = deps.now();
  const report: LinkedInReplyReconcileReport = { checked: 0, found: 0, uncertain: 0, waiting: 0 };
  for (const item of await deps.store.listUnsettled(new Date(now.getTime() - LINKEDIN_RECONCILE_AFTER_MS), limit)) {
    report.checked += 1;
    const { send } = item;
    let found: { messageId: string | null } | null;
    try {
      if (!(await deps.sender.available(send.organizationId))) throw new Error("LinkedIn is not connected");
      found = await deps.sender.findSent({ organizationId: send.organizationId, account: send.providerAccountId, chat: send.chat, text: send.text, since: new Date(item.startedAt.getTime() - 60_000) });
    } catch {
      report.waiting += 1;
      continue;
    }
    if (found) {
      await deps.store.markSent(send, { providerMessageId: found.messageId }, now, "Found in the LinkedIn chat by its text.");
      report.found += 1;
    } else if (item.status === "sending" && now.getTime() - item.startedAt.getTime() >= LINKEDIN_UNCERTAIN_AFTER_MS) {
      await deps.store.markUncertain(send, "The send never reported an outcome and the message is not in the LinkedIn chat.");
      report.uncertain += 1;
    } else {
      report.waiting += 1;
    }
  }
  return report;
}
