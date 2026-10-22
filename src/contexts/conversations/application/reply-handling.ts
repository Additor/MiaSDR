import { z } from "zod";
import { retryOnce } from "@/platform/db/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import {
  PROTECTED_SUBCATEGORY_KEY,
  isCategoryKey,
  parseInstructionBlocks,
  parsePipelineSettings,
  parseSubcategoryInput,
  parseSubcategoryPatch,
  type CategoryKey,
} from "../domain/reply-handling";
import type { ReplyHandlingStore, IdentityExceptionRow, RecordDetail } from "./reply-handling-ports";
import type { InboundLinkedInInput } from "./linkedin-ports";
import type { InboundEmailInput, IngestResult, InboxStore, ThreadMessage } from "./ports";
import { resolveUncertainSend, type ReplyDeps } from "./reply-management";
import { noteScope, type NoteTarget } from "../actions/application/tasks";

/**
 * Reply handling: the reply record behind each Inbox thread, identity exceptions and settings. Any member
 * of the organization may use them (decisions.md, "AI replies"). Every store call carries the actor's organization, so
 * another organization's ids answer 404.
 *
 * Nothing here sends a message. Drafts are approved and sent only through `approveAndSendDraft`.
 */

export interface ReplyHandlingDeps {
  store: ReplyHandlingStore;
  inbox: InboxStore;
  now: () => Date;
  /** Files a quarantined inbound message under the person a reviewer chose. Both calls are idempotent per provider message. */
  replay: {
    email(input: InboundEmailInput): Promise<IngestResult>;
    linkedin(input: InboundLinkedInInput): Promise<IngestResult>;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id: string, what: string) => {
  if (!UUID.test(id)) throw new NotFoundError(`${what} not found`);
};

export interface TimelineMessage extends ThreadMessage {
  conversationId: string;
  channel: string;
  accountLabel: string;
}

/**
 * Everything the Inbox thread shows about its reply record in the side column: category, history, drafts, events,
 * notes, enrollments and the person's other public conversations. A record whose only threads are private answers 404.
 */
export async function getRecordDetail(deps: ReplyHandlingDeps, actor: Actor, recordId: string): Promise<RecordDetail> {
  assertId(recordId, "Reply handling");
  const detail = await deps.store.recordDetail(actor.organizationId, recordId);
  if (!detail) throw new NotFoundError("Reply handling not found");
  return detail;
}

/** The record with one timeline across its email and LinkedIn conversations, oldest first. */
export async function getRecord(deps: ReplyHandlingDeps, actor: Actor, recordId: string) {
  const detail = await getRecordDetail(deps, actor, recordId);
  const threads = await Promise.all(detail.conversations.map((c) => deps.inbox.thread(actor.organizationId, c.id)));
  const timeline: TimelineMessage[] = threads
    .flatMap((thread) => (thread ? thread.messages.map((m) => ({ ...m, conversationId: thread.conversationId, channel: thread.channel, accountLabel: thread.accountLabel })) : []))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return { ...detail, timeline };
}

export interface MoveStageInput {
  categoryKey: string;
  subcategoryId: string | null;
  expectedContextVersion: number;
  confirmUnlock?: boolean;
  note?: string | null;
  occurredAt?: Date | null;
}

/**
 * A person moves a record to another stage because something happened off the thread (a meeting took
 * place, a trial started). The AI's reading of the latest reply stays as it was; the move is logged as
 * `stage.moved`. A move into Do not contact also sets the person's do-not-contact flag, because the
 * person who made it has decided to stop contact.
 */
export async function moveRecordStage(deps: ReplyHandlingDeps, actor: Actor, recordId: string, input: MoveStageInput) {
  assertId(recordId, "Reply handling");
  if (!isCategoryKey(input.categoryKey)) throw new ValidationError("Choose one of the four categories.");
  if (input.subcategoryId !== null) assertId(input.subcategoryId, "Subcategory");
  if (!Number.isInteger(input.expectedContextVersion) || input.expectedContextVersion < 0) throw new ValidationError("The reply handling version is missing. Reload and try again.");
  const note = input.note?.trim() || null;
  if (note && note.length > 4000) throw new ValidationError("The note is longer than 4000 characters.");
  const now = deps.now();
  const occurredAt = input.occurredAt ?? now;
  if (occurredAt.getTime() > now.getTime() + 60_000) throw new ConflictError("A category change cannot be dated in the future.");

  const result = await deps.store.moveStage({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    recordId,
    categoryKey: input.categoryKey as CategoryKey,
    subcategoryId: input.subcategoryId,
    expectedContextVersion: input.expectedContextVersion,
    confirmUnlock: input.confirmUnlock === true,
    note,
    occurredAt,
    now,
  });
  await followDoNotContactCategory(deps, actor, result);
  return result;
}

/**
 * A person put the record in Do not contact, by a move off the thread or by their own reading of the reply: they have decided
 * to stop contact, so the do-not-contact flag follows on every channel. Any other subcategory leaves the flag alone.
 */
export async function followDoNotContactCategory(deps: ReplyHandlingDeps, actor: Actor, result: { personId: string; subcategoryKey: string | null }) {
  if (result.subcategoryKey !== PROTECTED_SUBCATEGORY_KEY) return;
  await deps.store.setDoNotContact({ organizationId: actor.organizationId, actorUserId: actor.userId, personId: result.personId, enabled: true, reason: "Moved to Do not contact by a person.", now: deps.now() });
}

/** Reverts the latest applied classification to what the record had before, as a person's decision. */
export async function undoClassification(deps: ReplyHandlingDeps, actor: Actor, classificationId: string) {
  assertId(classificationId, "Classification");
  return deps.store.undoClassification({ organizationId: actor.organizationId, actorUserId: actor.userId, classificationId, now: deps.now() });
}

/** Marks an AI classification as seen. A held proposal is not acknowledged, it is accepted or overridden. */
export async function acknowledgeClassification(deps: ReplyHandlingDeps, actor: Actor, classificationId: string): Promise<void> {
  assertId(classificationId, "Classification");
  await deps.store.acknowledgeClassification({ organizationId: actor.organizationId, actorUserId: actor.userId, classificationId, now: deps.now() });
}

/**
 * Do not contact applies to the person on every channel. Setting it stops the person's pending and
 * active campaign enrollments, retires open drafts and puts their records back in front of a human.
 * Clearing it removes the flag only; enrollments that were stopped stay stopped.
 */
export async function setPersonDoNotContact(deps: ReplyHandlingDeps, actor: Actor, personId: string, input: { enabled: boolean; reason?: string | null }) {
  assertId(personId, "Person");
  const reason = dncReason(input.enabled, input.reason);
  return deps.store.setDoNotContact({ organizationId: actor.organizationId, actorUserId: actor.userId, personId, enabled: input.enabled, reason, now: deps.now() });
}

function dncReason(enabled: boolean, raw: string | null | undefined): string {
  const reason = raw?.trim() || (enabled ? "" : "Cleared by a person.");
  if (enabled && reason === "") throw new ValidationError("Say why this person should not be contacted.");
  if (reason.length > 500) throw new ValidationError("The reason is longer than 500 characters.");
  return reason;
}

export const MAX_BULK_DNC_IDS = 200;
/** A bulk request stops starting new people after this long and reports the rest as `retryable`, as bulk deal creation does. */
export const BULK_DNC_TIME_BUDGET_MS = 20_000;

export type BulkDncSkipReason = "already_marked" | "not_found" | "retryable";

export interface BulkDncResult {
  marked: number;
  skipped: Array<{ personId: string; reason: BulkDncSkipReason }>;
}

/**
 * Marks up to 200 people do not contact with one reason. Each person runs in a transaction of their own through
 * `setDoNotContact`, the single-person lock path, once more after a deadlock or lock timeout. A person who fails is
 * skipped and the batch goes on, so `marked` plus the skipped add up to the distinct ids sent.
 */
export async function setPeopleDoNotContact(deps: ReplyHandlingDeps, actor: Actor, ids: readonly string[], input: { reason?: string | null }): Promise<BulkDncResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > MAX_BULK_DNC_IDS) throw new ValidationError(`Mark 1 to ${MAX_BULK_DNC_IDS} people per request.`);
  const reason = dncReason(true, input.reason);
  const result: BulkDncResult = { marked: 0, skipped: [] };
  const deadline = deps.now().getTime() + BULK_DNC_TIME_BUDGET_MS;
  for (const [index, personId] of unique.entries()) {
    if (deps.now().getTime() >= deadline) {
      for (const rest of unique.slice(index)) result.skipped.push({ personId: rest, reason: "retryable" });
      break;
    }
    if (!UUID.test(personId)) {
      result.skipped.push({ personId, reason: "not_found" });
      continue;
    }
    try {
      const done = await retryOnce(() =>
        deps.store.setDoNotContact({ organizationId: actor.organizationId, actorUserId: actor.userId, personId, enabled: true, reason, now: deps.now() }),
      );
      if (done.changed) result.marked += 1;
      else result.skipped.push({ personId, reason: "already_marked" });
    } catch (error) {
      if (error instanceof NotFoundError) {
        result.skipped.push({ personId, reason: "not_found" });
        continue;
      }
      if (!(error instanceof ConflictError && error.details?.code === "try_again")) {
        console.error(`[crm] bulk do not contact failed for person ${personId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      result.skipped.push({ personId, reason: "retryable" });
    }
  }
  return result;
}

export async function closeRecord(deps: ReplyHandlingDeps, actor: Actor, recordId: string, input: { reason: string }): Promise<void> {
  assertId(recordId, "Reply handling");
  const reason = input.reason.trim();
  if (reason === "" || reason.length > 500) throw new ValidationError("Give a reason of 1 to 500 characters.");
  await deps.store.closeRecord({ organizationId: actor.organizationId, actorUserId: actor.userId, recordId, reason, now: deps.now() });
}

export async function reopenRecord(deps: ReplyHandlingDeps, actor: Actor, recordId: string): Promise<void> {
  assertId(recordId, "Reply handling");
  await deps.store.reopenRecord({ organizationId: actor.organizationId, actorUserId: actor.userId, recordId, now: deps.now() });
}

/** A note on a record (`target` is its id) or on a person without one (`{ personId }`, stored with a null `record_id`). */
export async function addRecordNote(deps: ReplyHandlingDeps, actor: Actor, target: NoteTarget, input: { title?: string | null; body: string }) {
  const scope = noteScope(target);
  const body = input.body.trim();
  if (body === "" || body.length > 10_000) throw new ValidationError("The note must be 1 to 10,000 characters.");
  const title = input.title?.trim() || null;
  if (title && title.length > 200) throw new ValidationError("The title is longer than 200 characters.");
  return deps.store.addNote({ organizationId: actor.organizationId, actorUserId: actor.userId, scope, title, body });
}

export async function deleteRecordNote(deps: ReplyHandlingDeps, actor: Actor, target: NoteTarget, noteId: string): Promise<void> {
  const scope = noteScope(target);
  assertId(noteId, "Note");
  if (!(await deps.store.deleteNote({ organizationId: actor.organizationId, scope, noteId }))) throw new NotFoundError("Note not found");
}

/** A person's call on an uncertain reply, addressed by its send attempt. Reuses the inbox's resolution, which never resends. */
export async function reconcileSendAttempt(
  deps: ReplyHandlingDeps,
  reply: ReplyDeps,
  actor: Actor,
  attemptId: string,
  input: { delivered: boolean; note: string },
): Promise<void> {
  assertId(attemptId, "Send attempt");
  const draftId = await deps.store.draftIdForAttempt(actor.organizationId, attemptId);
  if (!draftId) throw new NotFoundError("Send attempt not found");
  await resolveUncertainSend(reply, actor, draftId, { outcome: input.delivered ? "delivered" : "not_delivered", note: input.note });
}

// Settings

function requireAdmin(actor: Actor): void {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change reply settings.");
}

export const getReplyTaxonomy = (deps: ReplyHandlingDeps, actor: Actor) => deps.store.taxonomy(actor.organizationId);

export async function createSubcategory(deps: ReplyHandlingDeps, actor: Actor, raw: Record<string, unknown>) {
  requireAdmin(actor);
  const input = parseSubcategoryInput(raw);
  const { subcategories } = await deps.store.taxonomy(actor.organizationId);
  if (subcategories.some((s) => s.key === input.key)) throw new ConflictError(`A subcategory with the key "${input.key}" already exists.`);
  if (subcategories.some((s) => s.categoryKey === input.categoryKey && s.name.toLowerCase() === input.name.toLowerCase())) {
    throw new ConflictError(`"${input.name}" already exists in this category.`);
  }
  return deps.store.createSubcategory(actor.organizationId, input);
}

export async function updateSubcategory(deps: ReplyHandlingDeps, actor: Actor, id: string, raw: Record<string, unknown>): Promise<void> {
  requireAdmin(actor);
  assertId(id, "Subcategory");
  const patch = parseSubcategoryPatch(raw);
  const { subcategories } = await deps.store.taxonomy(actor.organizationId);
  const current = subcategories.find((s) => s.id === id);
  if (!current) throw new NotFoundError("Subcategory not found");
  if (current.key === PROTECTED_SUBCATEGORY_KEY && patch.active === false) throw new ConflictError("Do not contact drives the stop-contact paths and cannot be archived.");
  if (patch.name && subcategories.some((s) => s.id !== id && s.categoryKey === current.categoryKey && s.name.toLowerCase() === patch.name!.toLowerCase())) {
    throw new ConflictError(`"${patch.name}" already exists in this category.`);
  }
  await deps.store.updateSubcategory(actor.organizationId, id, patch);
}

/** Delete is blocked while records or classification history use the subcategory. Archive it instead. */
export async function deleteSubcategory(deps: ReplyHandlingDeps, actor: Actor, id: string): Promise<void> {
  requireAdmin(actor);
  assertId(id, "Subcategory");
  const { subcategories } = await deps.store.taxonomy(actor.organizationId);
  const current = subcategories.find((s) => s.id === id);
  if (!current) throw new NotFoundError("Subcategory not found");
  if (current.key === PROTECTED_SUBCATEGORY_KEY) throw new ConflictError("Do not contact drives the stop-contact paths and cannot be deleted.");
  if (current.recordCount > 0) throw new ConflictError(`${current.recordCount} ${current.recordCount === 1 ? "person is" : "people are"} in this subcategory. Move them first, or archive it.`);
  if (current.historyCount > 0) throw new ConflictError("Classification history refers to this subcategory. Archive it instead of deleting it.");
  await deps.store.deleteSubcategory(actor.organizationId, id);
}

export async function updateReplySettings(deps: ReplyHandlingDeps, actor: Actor, raw: Record<string, unknown>): Promise<void> {
  requireAdmin(actor);
  await deps.store.updateSettings(actor.organizationId, parsePipelineSettings(raw));
}

export async function updateReplyAiInstructions(deps: ReplyHandlingDeps, actor: Actor, raw: { draftInstructions?: unknown; classificationInstructions?: unknown }): Promise<void> {
  requireAdmin(actor);
  const patch: { draftInstructions?: ReturnType<typeof parseInstructionBlocks>; classificationInstructions?: ReturnType<typeof parseInstructionBlocks> } = {};
  if (raw.draftInstructions !== undefined) patch.draftInstructions = parseInstructionBlocks(raw.draftInstructions, "Drafting instructions");
  if (raw.classificationInstructions !== undefined) patch.classificationInstructions = parseInstructionBlocks(raw.classificationInstructions, "Classification instructions");
  if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to change.");
  await deps.store.updateSettings(actor.organizationId, patch);
}

// Identity exceptions

/**
 * The quarantined message. `organizationId` never comes from the payload: replay takes it from the
 * exception row, so a crafted payload cannot file mail under another organization.
 */
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "not a date");
const emailPayload = z.object({
  kind: z.literal("email"),
  message: z.object({
    accountRef: z.string().min(1),
    providerThreadId: z.string(),
    providerMessageId: z.string().min(1),
    rfcMessageId: z.string().nullable().default(null),
    inReplyTo: z.string().nullable().default(null),
    from: z.object({ email: z.string(), name: z.string().nullable().default(null) }),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).optional(),
    subject: z.string().default(""),
    bodyText: z.string(),
    receivedAt: isoDate,
    autoReply: z.boolean().default(false),
    possibleBounce: z.boolean().optional(),
  }),
});
const linkedinPayload = z.object({
  kind: z.literal("linkedin"),
  message: z.object({
    accountRef: z.string().min(1),
    accountName: z.string().nullable().default(null),
    providerThreadId: z.string().min(1),
    providerMessageId: z.string().min(1),
    counterparty: z.object({
      providerId: z.string().min(1),
      name: z.string().nullable().default(null),
      profileUrl: z.string().nullable().default(null),
      slug: z.string().nullable().default(null),
    }),
    bodyText: z.string(),
    receivedAt: isoDate,
  }),
});
export const identityPayloadSchema = z.discriminatedUnion("kind", [emailPayload, linkedinPayload]);
export type IdentityPayload = z.infer<typeof identityPayloadSchema>;

/**
 * Parks an inbound message whose sender cannot be matched to a lead, for a person to review.
 * Called by ingest paths; safe to call twice for the same provider event.
 */
export async function quarantineInbound(deps: ReplyHandlingDeps, input: { organizationId: string; sourceEventKey: string; identityValue: string | null; reason: string; payload: IdentityPayload }) {
  const payload = identityPayloadSchema.parse(input.payload);
  const reason = input.reason.trim();
  if (reason === "" || input.sourceEventKey.trim() === "") throw new ValidationError("A quarantined message needs a reason and a source event key.");
  return deps.store.insertIdentityException({
    organizationId: input.organizationId,
    channel: payload.kind,
    accountRef: payload.message.accountRef,
    sourceEventKey: input.sourceEventKey.trim(),
    identityValue: input.identityValue?.trim() || null,
    reason: reason.slice(0, 500),
    payload,
  });
}

export function listIdentityExceptions(deps: ReplyHandlingDeps, actor: Actor, status: "open" | "resolved" | "ignored" = "open"): Promise<IdentityExceptionRow[]> {
  return deps.store.listIdentityExceptions(actor.organizationId, status);
}

async function openException(deps: ReplyHandlingDeps, actor: Actor, id: string) {
  assertId(id, "Identity exception");
  const row = await deps.store.getIdentityException(actor.organizationId, id);
  if (!row) throw new NotFoundError("Identity exception not found");
  if (row.status !== "open") throw new ConflictError("This exception was already reviewed.");
  return row;
}

/**
 * Resolving files the quarantined message under the chosen person, so it reaches classification and the
 * action queue, then closes the exception. The replay is idempotent per provider message, so a failure
 * between the two steps is safe to retry.
 */
export async function resolveIdentityException(deps: ReplyHandlingDeps, actor: Actor, id: string, input: { personId: string }): Promise<{ conversationId: string }> {
  const row = await openException(deps, actor, id);
  assertId(input.personId, "Person");
  const person = await deps.store.personForReplay(actor.organizationId, input.personId);
  if (!person) throw new NotFoundError("Person not found");
  const parsed = identityPayloadSchema.safeParse(row.payload);
  if (!parsed.success) throw new ConflictError("The stored message cannot be replayed. Ignore this exception instead.");

  const base = { organizationId: actor.organizationId, personId: person.id };
  let result: IngestResult;
  if (parsed.data.kind === "email") {
    const m = parsed.data.message;
    result = await deps.replay.email({ ...base, ...m, receivedAt: new Date(m.receivedAt) });
  } else {
    const m = parsed.data.message;
    result = await deps.replay.linkedin({ ...base, ...m, receivedAt: new Date(m.receivedAt) });
  }
  const closed = await deps.store.closeIdentityException({ organizationId: actor.organizationId, id, outcome: { status: "resolved", personId: person.id }, now: deps.now() });
  if (!closed) throw new ConflictError("This exception was reviewed by someone else at the same time.");
  return { conversationId: result.conversationId };
}

export async function ignoreIdentityException(deps: ReplyHandlingDeps, actor: Actor, id: string): Promise<void> {
  await openException(deps, actor, id);
  const closed = await deps.store.closeIdentityException({ organizationId: actor.organizationId, id, outcome: { status: "ignored" }, now: deps.now() });
  if (!closed) throw new ConflictError("This exception was reviewed by someone else at the same time.");
}
