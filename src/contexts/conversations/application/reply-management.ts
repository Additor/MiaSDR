import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { checkManualReply, MANUAL_BODY_MAX, MANUAL_SUBJECT_MAX } from "../domain/manual-reply";
import { normalizeSubject } from "../domain/subject";
import { validateReplyCc, MAX_REPLY_CC, type ReplyCcError } from "../domain/lead-cc";
import { needsReply } from "../domain/reply-policy";
import { AiError } from "@/contexts/ai/domain/ai-error";
import { aiIsOn, aiOffMessage } from "@/contexts/integrations/domain/ai-status";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import type { ReplyAiResolver } from "../ai/application/ai-ports";
import { draftCitations, produceDraft } from "../ai/application/ai-jobs";
import { ReplySendError, type AttemptRow, type PanelData, type ReplyMailer, type ReplyStore, type SendContext } from "./reply-ports";
import { IN_FLIGHT_DRAFT_STATUSES, UNSENT_DRAFT_STATUSES } from "../domain/draft-status";

/**
 * Human actions on drafts. Permissions: any member of the organization may edit, regenerate, discard,
 * approve and send, override a classification and suppress a sender (decisions.md, "AI replies").
 * Cross-organization ids answer 404 because every store call carries the actor's organization.
 *
 * `approveAndSendDraft` is the only function in the product that sends a reply. The background jobs
 * hold no mailer, and no setting skips this step.
 */

export interface ReplyDeps {
  store: ReplyStore;
  ai: ReplyAiResolver;
  mailer: ReplyMailer;
  now: () => Date;
  /** Random local part for the Message-ID of a reply. The store adds the mailbox's domain. */
  newToken: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id: string, what: string) => {
  if (!UUID.test(id)) throw new NotFoundError(`${what} not found`);
};
const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * `aiOff` says what stops AI and how to turn it on, worded for the reader's role. Null when AI is on. `canManageAi`:
 * the reader can open Settings, Integrations to fix it.
 */
export type ReplyPanel = PanelData & { aiConfigured: boolean; aiOff: string | null; canManageAi: boolean; canGenerate: boolean };

const readerOf = (actor: Actor) => (isOwnerOrAdmin(actor.role) ? "admin" : "member");

export async function getReplyPanel(deps: ReplyDeps, actor: Actor, conversationId: string): Promise<ReplyPanel | null> {
  assertId(conversationId, "Conversation");
  const panel = await deps.store.panel(actor.organizationId, conversationId);
  if (!panel) throw new NotFoundError("Conversation not found");
  if (panel.channel !== "email") return null;
  const status = await deps.ai.status(actor.organizationId);
  const aiConfigured = aiIsOn(status);
  return { ...panel, aiConfigured, aiOff: aiOffMessage(status, readerOf(actor)), canManageAi: isOwnerOrAdmin(actor.role), canGenerate: aiConfigured && panel.recipient !== null };
}

async function requireProvider(deps: ReplyDeps, actor: Actor) {
  const provider = await deps.ai.forOrganization(actor.organizationId);
  if (!provider) throw new ValidationError(aiOffMessage(await deps.ai.status(actor.organizationId), readerOf(actor)) ?? "AI is off. Try again shortly.");
  return provider;
}

/** Generates a draft on request, for threads where the job made none (or AI was off when the reply arrived). */
export async function requestDraft(deps: ReplyDeps, actor: Actor, conversationId: string): Promise<{ draftId: string }> {
  assertId(conversationId, "Conversation");
  const provider = await requireProvider(deps, actor);
  const ctx = await deps.store.draftContext(actor.organizationId, conversationId);
  if (!ctx) throw new NotFoundError("Conversation not found");
  const panel = await deps.store.panel(actor.organizationId, conversationId);
  if (panel?.draft && UNSENT_DRAFT_STATUSES.includes(panel.draft.status)) throw new ConflictError("This thread already has a draft. Edit or regenerate it.");
  if (panel?.draft && IN_FLIGHT_DRAFT_STATUSES.includes(panel.draft.status)) {
    throw new ConflictError("A reply is being sent for this thread.");
  }
  try {
    const result = await produceDraft(provider, ctx);
    return {
      draftId: (
        await deps.store.insertDraft({
          organizationId: ctx.organizationId,
          recordId: ctx.recordId,
          conversationId: ctx.conversationId,
          replyForMessageId: ctx.replyForMessageId,
          expectedContextVersion: ctx.contextVersion,
          channel: ctx.channel,
          subject: result.output.subject,
          bodyText: result.output.bodyText,
          provider: provider.name,
          model: provider.model,
          request: { requestedBy: actor.userId, contextVersion: ctx.contextVersion },
          response: { usage: result.usage ?? null },
          citations: draftCitations(ctx),
        })
      ).id,
    };
  } catch (error) {
    throw asValidation(error);
  }
}

function asValidation(error: unknown) {
  if (error instanceof AiError) return new ValidationError(`The AI could not write a draft: ${error.message}`);
  return error;
}

export async function regenerateDraft(deps: ReplyDeps, actor: Actor, draftId: string, input: { note?: string }): Promise<{ draftId: string }> {
  assertId(draftId, "Draft");
  const provider = await requireProvider(deps, actor);
  const ctx = await deps.store.draftContextForDraft(actor.organizationId, draftId);
  if (!ctx) throw new NotFoundError("Draft not found");
  if (!["awaiting_review", "failed", "stale"].includes(ctx.draft.status)) {
    throw new ConflictError(`A draft that is ${ctx.draft.status.replace(/_/g, " ")} cannot be regenerated.`);
  }
  const note = input.note?.trim().slice(0, 2000) || null;
  try {
    const result = await produceDraft(provider, ctx, { feedback: note, previousDraft: ctx.draft.editedBodyText ?? ctx.draft.aiBodyText });
    return {
      draftId: (
        await deps.store.insertDraft({
          organizationId: ctx.organizationId,
          recordId: ctx.recordId,
          conversationId: ctx.conversationId,
          replyForMessageId: ctx.replyForMessageId,
          expectedContextVersion: ctx.contextVersion,
          channel: ctx.channel,
          subject: result.output.subject,
          bodyText: result.output.bodyText,
          provider: provider.name,
          model: provider.model,
          request: { regeneratedBy: actor.userId, contextVersion: ctx.contextVersion },
          response: { usage: result.usage ?? null },
          citations: draftCitations(ctx),
          regeneratesDraftId: draftId,
          feedback: note,
        })
      ).id,
    };
  } catch (error) {
    throw asValidation(error);
  }
}

function ccMessage(error: ReplyCcError): string {
  switch (error.code) {
    case "invalid":
      return `${error.email} is not a valid email address.`;
    case "too_many":
      return `A reply can have at most ${MAX_REPLY_CC} CC addresses.`;
    case "unknown":
      return `${error.email} has not been on this lead's mail, so it cannot be added as CC.`;
    case "excluded":
      return `${error.email} is the lead or your own mailbox and cannot be CC'd.`;
  }
}

/** Checks a CC choice against the addresses seen on the lead's mail, then against suppression and do-not-contact. */
async function checkCc(deps: ReplyDeps, actor: Actor, target: { draftId: string } | { conversationId: string }, chosen: string[]): Promise<string[]> {
  const ctx = "draftId" in target ? await deps.store.ccContext(actor.organizationId, target.draftId) : await deps.store.ccContextForConversation(actor.organizationId, target.conversationId);
  if (!ctx) throw new NotFoundError("draftId" in target ? "Draft not found" : "Conversation not found");
  const result = validateReplyCc(chosen, ctx);
  if (!result.ok) throw new ValidationError(ccMessage(result.error));
  const blocked = await deps.store.blockedAddresses(actor.organizationId, result.cc);
  const first = blocked[0];
  if (first) {
    throw new ConflictError(
      first.reason === "suppressed"
        ? `${first.email} is on the suppression list and cannot be added as CC.`
        : `${first.email} is marked do not contact and cannot be added as CC.`,
    );
  }
  return result.cc;
}

/**
 * A reply a person types, with no AI involved: it needs no provider and never reads one. The result is an ordinary
 * `awaiting_review` draft, so edit, CC, suppression, do-not-contact and `approveAndSendDraft` apply unchanged.
 * An open draft on the thread is superseded; edit it with `editDraft` to keep it instead.
 */
export async function createManualDraft(
  deps: ReplyDeps,
  actor: Actor,
  conversationId: string,
  input: { subject: string | null | undefined; bodyText: string; cc?: string[] },
): Promise<{ draftId: string; revision: number }> {
  assertId(conversationId, "Conversation");
  const checked = checkManualReply(input);
  if (!checked.ok) throw new ValidationError(checked.error);
  const cc = input.cc && input.cc.length > 0 ? await checkCc(deps, actor, { conversationId }, input.cc) : [];
  const created = await deps.store.createManualDraft({
    organizationId: actor.organizationId,
    conversationId,
    subject: checked.subject,
    bodyText: checked.bodyText,
    cc,
    actorUserId: actor.userId,
  });
  return { draftId: created.id, revision: created.revision };
}

export async function editDraft(deps: ReplyDeps, actor: Actor, draftId: string, input: { revision: number; subject?: string | null; bodyText: string; cc?: string[] }) {
  assertId(draftId, "Draft");
  const bodyText = input.bodyText.replace(/\r\n/g, "\n").trim();
  if (bodyText === "") throw new ValidationError("The reply cannot be empty.");
  if (bodyText.length > MANUAL_BODY_MAX) throw new ValidationError(`The reply is longer than ${MANUAL_BODY_MAX} characters.`);
  const subject = input.subject === undefined || input.subject === null ? null : normalizeSubject(input.subject, MANUAL_SUBJECT_MAX + 1);
  if (subject !== null && (subject === "" || subject.length > MANUAL_SUBJECT_MAX)) throw new ValidationError(`The subject must be 1 to ${MANUAL_SUBJECT_MAX} characters.`);
  const cc = input.cc === undefined ? undefined : await checkCc(deps, actor, { draftId }, input.cc);
  const draft = await deps.store.updateDraft(actor.organizationId, draftId, { expectedRevision: input.revision, subject, bodyText, ...(cc ? { cc } : {}) });
  return { revision: draft.revision };
}

export async function discardDraft(deps: ReplyDeps, actor: Actor, draftId: string): Promise<void> {
  assertId(draftId, "Draft");
  await deps.store.discardDraft(actor.organizationId, draftId, actor.userId);
}

export type SendResult =
  | { status: "sent"; attemptId: string; replayed: boolean }
  | { status: "delivery_uncertain"; attemptId: string; replayed: boolean; error: string | null }
  | { status: "failed"; attemptId: string; replayed: boolean; error: string }
  | { status: "blocked"; attemptId: string; replayed: false; error: string }
  | { status: "in_progress"; attemptId: string; replayed: true };

const BLOCK_TEXT = {
  suppressed: "This address is on the suppression list. The reply was not sent.",
  do_not_contact: "This person is marked do not contact. The reply was not sent.",
  mailbox_unavailable: "The mailbox this thread belongs to is not connected. The reply was not sent.",
  cc_blocked: "A CC address is suppressed or marked do not contact. Remove it from the CC list and send again. The reply was not sent.",
} as const;

function replay(attempt: AttemptRow): SendResult {
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

/**
 * The approval gate. A person approves one revision of one draft. The ledger row exists before the
 * provider is called, so a crash can never lose track of an attempt, and an unknown outcome is never
 * sent again on a guess.
 */
export async function approveAndSendDraft(
  deps: ReplyDeps,
  actor: Actor,
  draftId: string,
  input: { revision: number; idempotencyKey: string },
): Promise<SendResult> {
  assertId(draftId, "Draft");
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new ValidationError("An idempotency key of 8 to 200 characters is required.");

  const begun = await deps.store.beginSend({
    organizationId: actor.organizationId,
    draftId,
    expectedRevision: input.revision,
    idempotencyKey: key,
    actorUserId: actor.userId,
    messageIdToken: deps.newToken(),
  });
  if (begun.kind === "replay") return replay(begun.attempt);
  const send = begun.send;

  // Checked after the ledger row exists and right before the provider call.
  const blocker = await deps.store.checkBlockers(send);
  if (blocker) {
    await deps.store.markFailed(send, BLOCK_TEXT[blocker], blocker === "mailbox_unavailable" || blocker === "cc_blocked" ? "awaiting_review" : "failed");
    return { status: "blocked", attemptId: send.attempt.id, replayed: false, error: BLOCK_TEXT[blocker] };
  }

  try {
    const sent = await deps.mailer.send({
      mailbox: { emailAddress: send.mailbox!.emailAddress, displayName: send.mailbox!.displayName, signatureHtml: send.mailbox!.signatureHtml },
      to: send.recipient,
      cc: send.cc,
      subject: send.subject,
      bodyText: send.bodyText,
      rfcMessageId: send.rfcMessageId,
      inReplyTo: send.inReplyTo,
      references: send.references,
      threadId: send.threadId,
      organizationId: send.organizationId,
    });
    await deps.store.markSent(send, sent, deps.now());
    return { status: "sent", attemptId: send.attempt.id, replayed: false };
  } catch (error) {
    if (error instanceof ReplySendError && error.kind === "definite") {
      await deps.store.markFailed(send, error.message, "awaiting_review");
      return { status: "failed", attemptId: send.attempt.id, replayed: false, error: error.message };
    }
    // Anything else might have gone out. Never retried on a guess.
    await deps.store.markUncertain(send, text(error));
    return { status: "delivery_uncertain", attemptId: send.attempt.id, replayed: false, error: text(error) };
  }
}

/** A person's call on an uncertain send, after checking the mailbox's Sent folder. */
export async function resolveUncertainSend(
  deps: ReplyDeps,
  actor: Actor,
  draftId: string,
  input: { outcome: "delivered" | "not_delivered"; note: string },
): Promise<void> {
  assertId(draftId, "Draft");
  const note = input.note.trim();
  if (note === "") throw new ValidationError("Add a note about how you checked.");
  await deps.store.resolveUncertain({ organizationId: actor.organizationId, draftId, outcome: input.outcome, note: note.slice(0, 1000), actorUserId: actor.userId, now: deps.now() });
}

export interface ReconcileReport {
  checked: number;
  found: number;
  uncertain: number;
  waiting: number;
}

export const RECONCILE_AFTER_MS = 10 * 60_000;
export const UNCERTAIN_AFTER_MS = 30 * 60_000;

/**
 * Looks in the mailbox for sends with no recorded outcome. Found: the send is settled as delivered.
 * Missing: it stays (or becomes) `delivery_uncertain` for a person to decide. Nothing is resent.
 */
export async function reconcileReplies(deps: ReplyDeps, limit = 25): Promise<ReconcileReport> {
  const now = deps.now();
  const report: ReconcileReport = { checked: 0, found: 0, uncertain: 0, waiting: 0 };
  for (const item of await deps.store.listUnsettled(new Date(now.getTime() - RECONCILE_AFTER_MS), limit)) {
    report.checked += 1;
    const { send } = item;
    if (!send.mailbox) {
      report.waiting += 1;
      continue;
    }
    let found;
    try {
      found = await deps.mailer.findSent(send.mailbox.emailAddress, send.rfcMessageId, item.startedAt, { to: send.recipient });
    } catch {
      report.waiting += 1;
      continue;
    }
    if (found.status === "found") {
      await deps.store.markSent(send, found.sent, now, "Found in the mailbox's sent mail by its message id.");
      report.found += 1;
    } else if (item.status === "sending" && now.getTime() - item.startedAt.getTime() >= UNCERTAIN_AFTER_MS) {
      // Uncertain only asks a person to decide, so it is safe for both answers. Nothing is resent.
      await deps.store.markUncertain(
        send,
        found.status === "absent"
          ? "The send never reported an outcome and the message is not in the mailbox."
          : `The send never reported an outcome and the mailbox could not confirm it either way (${found.reason}).`,
      );
      report.uncertain += 1;
    } else {
      report.waiting += 1;
    }
  }
  return report;
}

/**
 * Accept the AI's held proposal (replyTypeKey null) or choose another category. Recorded as a human decision. The
 * person sends the context version they looked at; a mismatch is a 409. A correction retires open drafts, ends the
 * sequence run, and starts the new category's sequence and a fresh draft.
 */
export async function setReplyType(
  deps: ReplyDeps,
  actor: Actor,
  conversationId: string,
  input: { replyTypeKey: string | null; expectedContextVersion: number },
) {
  assertId(conversationId, "Conversation");
  if (!Number.isInteger(input.expectedContextVersion) || input.expectedContextVersion < 0) throw new ValidationError("The reply handling version is missing. Reload and try again.");
  return deps.store.applyHumanReplyTypePick({
    organizationId: actor.organizationId,
    conversationId,
    replyTypeKey: input.replyTypeKey,
    expectedContextVersion: input.expectedContextVersion,
    actorUserId: actor.userId,
    wantsDraft: needsReply,
  });
}

/** One click: puts the sender's address on the suppression list and stops their sequences. Never done by the AI. */
export async function suppressSender(deps: ReplyDeps, actor: Actor, conversationId: string): Promise<{ email: string }> {
  assertId(conversationId, "Conversation");
  return deps.store.suppressSender({ organizationId: actor.organizationId, conversationId, actorUserId: actor.userId });
}

export type { SendContext };
