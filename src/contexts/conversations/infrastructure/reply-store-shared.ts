import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { contactPolicies, threads, drafts, mailboxes, people, conversations, replyTypePicks, sendAttempts, suppressionList, leadCcs } from "@/platform/db/schema";
import type { DraftRow, KnownCc, SendContext } from "../application/reply-ports";
import { DRAFT_FROM, type DraftStatus } from "../domain/draft-status";
import { PICK_FROM, type PickStatus } from "../domain/reply-type-pick";
import { organizationMailboxAddresses } from "./drizzle-thread-store";
import { toAttempt } from "./reply-attempt-ledger";

/** The drafts row may move to `to` from where it is now (see `DRAFT_FROM`). */
export const draftCanBecome = (to: DraftStatus) => inArray(drafts.status, [...DRAFT_FROM[to]]);

/** The reply_type_picks row may move to `to` from where it is now (see `PICK_FROM`). */
export const pickMayBecome = (to: PickStatus) => inArray(replyTypePicks.status, [...PICK_FROM[to]]);

/** The drafts row is in one of the named statuses. */
export const draftIn = (statuses: readonly DraftStatus[]) => inArray(drafts.status, [...statuses]);

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
    conversationId: d.conversationId,
    threadId: d.threadId,
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
    writtenViaTokenId: d.writtenViaTokenId,
  };
};

/** What the approval snapshot stores in `send_attempts.request`: exactly what the person approved. */
export interface Snapshot {
  rfcMessageId: string;
  to: string;
  /** Absent on attempts approved before CC existed. */
  cc?: string[];
  subject: string;
  bodyText: string;
  accountRef: string;
  threadId: string;
  conversationId: string;
  personId: string;
  providerThreadId: string | null;
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
    threadId: snap.threadId,
    conversationId: snap.conversationId,
    personId: snap.personId,
    recipient: snap.to,
    cc: snap.cc ?? [],
    subject: snap.subject,
    bodyText: snap.bodyText,
    rfcMessageId: snap.rfcMessageId,
    providerThreadId: snap.providerThreadId,
    inReplyTo: snap.inReplyTo,
    references: snap.references,
    mailbox: await mailboxFor(attempt.organizationId, snap.accountRef),
  };
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

export async function ccContextFor(organizationId: string, threadId: string) {
  const [row] = await db
    .select({ personId: conversations.personId, leadEmail: people.email, accountRef: threads.accountRef })
    .from(threads)
    .innerJoin(conversations, eq(conversations.id, threads.conversationId))
    .innerJoin(people, eq(people.id, conversations.personId))
    .where(and(eq(threads.id, threadId), eq(threads.organizationId, organizationId)));
  if (!row) return null;
  const known = await db.select({ email: leadCcs.email }).from(leadCcs).where(and(eq(leadCcs.organizationId, organizationId), eq(leadCcs.personId, row.personId)));
  const ours = new Set(await organizationMailboxAddresses(organizationId));
  return { known: known.map((k) => k.email).filter((e) => !ours.has(e.toLowerCase())), mailbox: row.accountRef, lead: row.leadEmail };
}
