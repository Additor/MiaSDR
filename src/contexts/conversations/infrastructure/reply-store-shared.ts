import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { contactPolicies, conversations, drafts, events, mailboxes, messages, people, records, sendAttempts, suppressionList, leadCcs } from "@/platform/db/schema";
import type { AttemptRow, DraftRow, KnownCc, SendContext } from "../application/reply-ports";
import { DRAFT_FROM, type DraftStatus } from "../domain/draft-status";
import { ATTEMPT_FROM, canMoveAttempt, type AttemptStatus } from "../domain/send-attempt-status";
import { organizationMailboxAddresses } from "./drizzle-conversation-store";
import { publicConversation } from "@/platform/db/conversation-visibility";

/** The drafts row may move to `to` from where it is now (see `DRAFT_FROM`). */
export const draftCanBecome = (to: DraftStatus) => inArray(drafts.status, [...DRAFT_FROM[to]]);

/** The drafts row is in one of the named statuses. */
export const draftIn = (statuses: readonly DraftStatus[]) => inArray(drafts.status, [...statuses]);

type Tx = DbTx;

interface DraftMeta {
  source?: string;
  regeneratedFrom?: string;
  feedback?: string;
}

export const toDraftRow = (d: typeof drafts.$inferSelect): DraftRow => {
  const meta = (d.request ?? {}) as DraftMeta;
  return {
    id: d.id,
    organizationId: d.organizationId,
    recordId: d.recordId,
    conversationId: d.conversationId,
    status: d.status as DraftStatus,
    revision: d.revision,
    expectedContextVersion: d.expectedContextVersion,
    subject: d.subject,
    aiBodyText: d.aiBodyText,
    editedBodyText: d.editedBodyText,
    cc: d.cc,
    error: d.error,
    model: d.model,
    source: meta.source === "manual" ? "manual" : "ai",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    regeneratedFrom: meta.regeneratedFrom ?? null,
    feedback: meta.feedback ?? null,
  };
};

export const toAttempt = (a: typeof sendAttempts.$inferSelect): AttemptRow => ({
  id: a.id,
  draftId: a.draftId,
  status: a.status as AttemptRow["status"],
  error: a.error,
  rfcMessageId: ((a.request ?? {}) as { rfcMessageId?: string }).rfcMessageId ?? null,
  providerMessageId: a.providerMessageId,
});

/** What the approval snapshot stores in `send_attempts.request`: exactly what the person approved. */
export interface Snapshot {
  rfcMessageId: string;
  to: string;
  /** Absent on attempts approved before CC existed. */
  cc?: string[];
  subject: string;
  bodyText: string;
  accountRef: string;
  conversationId: string;
  recordId: string;
  personId: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  revision: number;
  expectedContextVersion: number;
}

export async function mailboxFor(organizationId: string, accountRef: string) {
  const [row] = await db
    .select({ emailAddress: mailboxes.emailAddress, displayName: mailboxes.displayName, signatureHtml: mailboxes.signatureHtml, status: mailboxes.status })
    .from(mailboxes)
    .where(and(eq(mailboxes.organizationId, organizationId), sql`lower(${mailboxes.emailAddress}) = ${accountRef.toLowerCase()}`));
  return row ?? null;
}

export async function sendContextFor(attempt: typeof sendAttempts.$inferSelect): Promise<SendContext> {
  const snap = attempt.request as Snapshot;
  return {
    attempt: toAttempt(attempt),
    organizationId: attempt.organizationId,
    conversationId: snap.conversationId,
    recordId: snap.recordId,
    personId: snap.personId,
    recipient: snap.to,
    cc: snap.cc ?? [],
    subject: snap.subject,
    bodyText: snap.bodyText,
    rfcMessageId: snap.rfcMessageId,
    threadId: snap.threadId,
    inReplyTo: snap.inReplyTo,
    references: snap.references,
    mailbox: await mailboxFor(attempt.organizationId, snap.accountRef),
  };
}

/** Marks the attempt and draft delivered, stores the outbound message and moves the record on. Runs inside a transaction. */
export async function settleSent(tx: Tx, send: SendContext, sent: { providerMessageId: string | null; threadId: string | null }, now: Date, note?: string) {
  const [attempt] = await tx.select().from(sendAttempts).where(eq(sendAttempts.id, send.attempt.id)).for("update");
  if (!attempt || !canMoveAttempt(attempt.status as AttemptStatus, note ? "reconciled" : "sent")) return;
  const snap = attempt.request as Snapshot;
  await tx
    .update(sendAttempts)
    .set({
      status: note ? "reconciled" : "sent",
      providerMessageId: sent.providerMessageId,
      response: { threadId: sent.threadId },
      error: null,
      ...(note ? { reconciledAt: now, reconciliationNote: note } : {}),
    })
    .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM[note ? "reconciled" : "sent"]])));
  await tx.update(drafts).set({ status: "sent", error: null }).where(and(eq(drafts.id, attempt.draftId), draftCanBecome("sent")));

  await tx
    .insert(messages)
    .values({
      organizationId: attempt.organizationId,
      conversationId: snap.conversationId,
      channel: "email",
      accountRef: snap.accountRef.toLowerCase(),
      direction: "outbound",
      idempotencyKey: `reply:${attempt.id}`,
      providerMessageId: sent.providerMessageId,
      subject: snap.subject,
      fromAddress: snap.accountRef,
      toAddress: snap.to,
      bodyText: snap.bodyText,
      raw: { rfcMessageId: snap.rfcMessageId, draftId: attempt.draftId, attemptId: attempt.id, sentBy: attempt.actorUserId, cc: snap.cc ?? [] },
      sentAt: now,
    })
    .onConflictDoNothing();

  const at = sql`${now.toISOString()}::timestamptz`;
  await tx
    .update(records)
    .set({
      // A reply that arrived while this one was going out keeps the record waiting for a person.
      workflowState: sql`case when ${records.contextVersion} = ${snap.expectedContextVersion} then 'waiting' else ${records.workflowState} end`,
      lastOutboundAt: at,
      lastInteractionAt: sql`greatest(coalesce(${records.lastInteractionAt}, ${at}), ${at})`,
    })
    .where(eq(records.id, snap.recordId));
  await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, snap.conversationId));
  await tx.insert(events).values({
    organizationId: attempt.organizationId,
    personId: snap.personId,
    recordId: snap.recordId,
    eventType: note ? "draft.delivery_reconciled" : "draft.sent",
    actorType: "human",
    actorUserId: attempt.actorUserId,
    meta: { draftId: attempt.draftId, attemptId: attempt.id, note: note ?? null },
  });
}

/** Addresses that may not receive mail: on the suppression list, or the email of a person marked do not contact. */
export async function blockedAddressesFor(organizationId: string, emails: string[]): Promise<Array<{ email: string; reason: "suppressed" | "do_not_contact" }>> {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
  if (list.length === 0) return [];
  const suppressed = await db
    .select({ email: suppressionList.email })
    .from(suppressionList)
    .where(and(eq(suppressionList.organizationId, organizationId), inArray(suppressionList.email, list)));
  const dnc = await db
    .select({ email: people.email })
    .from(people)
    .innerJoin(contactPolicies, eq(contactPolicies.personId, people.id))
    .where(and(eq(people.organizationId, organizationId), eq(contactPolicies.doNotContact, true), inArray(sql`lower(${people.email})`, list)));
  const out: Array<{ email: string; reason: "suppressed" | "do_not_contact" }> = [];
  for (const email of list) {
    if (suppressed.some((s) => s.email.toLowerCase() === email)) out.push({ email, reason: "suppressed" });
    else if (dnc.some((d) => d.email?.toLowerCase() === email)) out.push({ email, reason: "do_not_contact" });
  }
  return out;
}

export async function knownCcsFor(organizationId: string, personId: string): Promise<KnownCc[]> {
  const rows = await db
    .select({ email: leadCcs.email, lastSeenAt: leadCcs.lastSeenAt })
    .from(leadCcs)
    .where(and(eq(leadCcs.organizationId, organizationId), eq(leadCcs.personId, personId)))
    .orderBy(desc(leadCcs.lastSeenAt), leadCcs.email);
  const [lead] = await db.select({ email: people.email }).from(people).where(and(eq(people.id, personId), eq(people.organizationId, organizationId)));
  const skip = new Set([lead?.email?.toLowerCase(), ...(await organizationMailboxAddresses(organizationId))]);
  const visible = rows.filter((r) => !skip.has(r.email.toLowerCase()));
  const blocked = new Map((await blockedAddressesFor(organizationId, visible.map((r) => r.email))).map((b) => [b.email, b.reason]));
  return visible.map((r) => ({ email: r.email, lastSeenAt: r.lastSeenAt, blocked: blocked.get(r.email) ?? null }));
}

export async function ccContextFor(organizationId: string, conversationId: string) {
  const [row] = await db
    .select({ personId: records.personId, leadEmail: people.email, accountRef: conversations.accountRef })
    .from(conversations)
    .innerJoin(records, eq(records.id, conversations.recordId))
    .innerJoin(people, eq(people.id, records.personId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId), publicConversation));
  if (!row) return null;
  const known = await db.select({ email: leadCcs.email }).from(leadCcs).where(and(eq(leadCcs.organizationId, organizationId), eq(leadCcs.personId, row.personId)));
  const ours = new Set(await organizationMailboxAddresses(organizationId));
  return { known: known.map((k) => k.email).filter((e) => !ours.has(e.toLowerCase())), mailbox: row.accountRef, lead: row.leadEmail };
}
