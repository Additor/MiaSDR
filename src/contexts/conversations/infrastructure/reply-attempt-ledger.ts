import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { threads, drafts, events, linkedinAccounts, messages, people, conversations, sendAttempts } from "@/platform/db/schema";
import { viaMeta } from "@/shared/errors";
import type { AttemptRow } from "../application/reply-ports";
import { DRAFT_FROM, IN_FLIGHT_DRAFT_STATUSES, type DraftStatus } from "../domain/draft-status";
import { ATTEMPT_FROM, ATTEMPT_FROM_CALL, canMoveAttempt, type AttemptStatus } from "../domain/send-attempt-status";
import { attemptVia } from "./agent-reply-gate";
import type { Snapshot as EmailSnapshot } from "./reply-store-shared";

/**
 * How a send attempt settles, on either channel. The claims stay apart (`beginSend`, `begin`): their locks and checks differ.
 * Once a provider answered, the rows move the same way: the attempt first and then its draft, so every settle takes the
 * locks in that order. Each write compares the status it moves from, so a late answer changes nothing.
 */

/** What the approval snapshot stores in `send_attempts.request` for a LinkedIn reply. */
export interface LinkedInSnapshot {
  channel: "linkedin";
  text: string;
  chat: string;
  accountId: string;
  providerAccountId: string;
  threadId: string;
  conversationId: string;
  personId: string;
  revision: number;
  expectedContextVersion: number;
}

type AttemptRecord = typeof sendAttempts.$inferSelect;

/** The outbound message without what the settle itself decides. */
type OutboundMessage = Omit<typeof messages.$inferInsert, "idempotencyKey" | "providerMessageId" | "sentAt">;

export const toAttempt = (a: AttemptRecord): AttemptRow => ({
  id: a.id,
  draftId: a.draftId,
  status: a.status as AttemptRow["status"],
  error: a.error,
  rfcMessageId: ((a.request ?? {}) as { rfcMessageId?: string }).rfcMessageId ?? null,
  providerMessageId: a.providerMessageId,
});

/** A key names one send of one draft. The request may spell the uuid in uppercase, and the stored id never does. */
export const attemptOfAnotherDraft = (attempt: Pick<AttemptRecord, "draftId">, requestedDraftId: string): boolean => attempt.draftId !== requestedDraftId.toLowerCase();

/** The email thread's outbound message, as the person approved it. */
function emailMessage(attempt: AttemptRecord, via: { tokenName: string } | null | undefined): OutboundMessage {
  const snap = attempt.request as EmailSnapshot;
  return {
    organizationId: attempt.organizationId,
    threadId: snap.threadId,
    channel: "email",
    accountRef: snap.accountRef.toLowerCase(),
    direction: "outbound",
    subject: snap.subject,
    fromAddress: snap.accountRef,
    toAddress: snap.to,
    bodyText: snap.bodyText,
    raw: { rfcMessageId: snap.rfcMessageId, draftId: attempt.draftId, attemptId: attempt.id, sentBy: attempt.actorUserId, cc: snap.cc ?? [], ...(via ? { sentVia: via.tokenName } : {}) },
  };
}

/** The LinkedIn chat's outbound message, as the person approved it. */
async function linkedInMessage(tx: DbTx, attempt: AttemptRecord, via: { tokenName: string } | null | undefined): Promise<OutboundMessage> {
  const snap = attempt.request as LinkedInSnapshot;
  const [account] = await tx.select({ name: linkedinAccounts.name, username: linkedinAccounts.username }).from(linkedinAccounts).where(eq(linkedinAccounts.id, snap.accountId));
  const [person] = await tx.select({ name: people.fullName, first: people.firstName }).from(people).where(eq(people.id, snap.personId));
  return {
    organizationId: attempt.organizationId,
    threadId: snap.threadId,
    channel: "linkedin",
    accountRef: snap.accountId,
    direction: "outbound",
    fromAddress: account?.name ?? account?.username ?? "LinkedIn account",
    toAddress: person?.name ?? person?.first ?? null,
    bodyText: snap.text,
    raw: { draftId: attempt.draftId, attemptId: attempt.id, sentBy: attempt.actorUserId, ...(via ? { sentVia: via.tokenName } : {}) },
  };
}

/** Marks the attempt and draft delivered, stores the outbound message and moves the conversation on. Runs inside a transaction. */
export async function settleAttemptSentTx(tx: DbTx, attemptId: string, sent: { providerMessageId: string | null; providerThreadId?: string | null }, now: Date, note?: string): Promise<void> {
  const [attempt] = await tx.select().from(sendAttempts).where(eq(sendAttempts.id, attemptId)).for("update");
  if (!attempt || !canMoveAttempt(attempt.status as AttemptStatus, note ? "reconciled" : "sent")) return;
  const linkedIn = attempt.provider === "linkedin";
  const snap = attempt.request as Pick<EmailSnapshot, "threadId" | "conversationId" | "personId" | "expectedContextVersion">;
  const via = await attemptVia(tx, attempt);
  await tx
    .update(sendAttempts)
    .set({
      status: note ? "reconciled" : "sent",
      providerMessageId: sent.providerMessageId,
      ...(linkedIn ? {} : { response: { providerThreadId: sent.providerThreadId ?? null } }),
      error: null,
      ...(note ? { reconciledAt: now, reconciliationNote: note } : {}),
    })
    .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM[note ? "reconciled" : "sent"]])));
  await tx.update(drafts).set({ status: "sent", error: null }).where(and(eq(drafts.id, attempt.draftId), inArray(drafts.status, [...DRAFT_FROM.sent])));

  const message = linkedIn ? await linkedInMessage(tx, attempt, via) : emailMessage(attempt, via);
  await tx
    .insert(messages)
    .values({ ...message, idempotencyKey: `reply:${attempt.id}`, providerMessageId: sent.providerMessageId, sentAt: now })
    .onConflictDoNothing();

  const at = sql`${now.toISOString()}::timestamptz`;
  await tx
    .update(conversations)
    .set({
      // A reply that arrived while this one was going out keeps the conversation waiting for a person.
      workflowState: sql`case when ${conversations.contextVersion} = ${snap.expectedContextVersion} then 'waiting' else ${conversations.workflowState} end`,
      closedReason: sql`case when ${conversations.contextVersion} = ${snap.expectedContextVersion} then null else ${conversations.closedReason} end`,
      lastOutboundAt: at,
      lastInteractionAt: sql`greatest(coalesce(${conversations.lastInteractionAt}, ${at}), ${at})`,
    })
    .where(eq(conversations.id, snap.conversationId));
  await tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, snap.threadId));
  await tx.insert(events).values({
    organizationId: attempt.organizationId,
    personId: snap.personId,
    conversationId: snap.conversationId,
    eventType: note ? "draft.delivery_reconciled" : "draft.sent",
    actorType: "human",
    actorUserId: attempt.actorUserId,
    meta: { draftId: attempt.draftId, attemptId: attempt.id, ...(linkedIn ? { channel: "linkedin" } : {}), note: note ?? null, ...viaMeta(via) },
  });
}

/** Compare-and-set: a late failure never overwrites sent, reconciled or an earlier failure. */
export async function failAttempt(attempt: { id: string; draftId: string }, error: string, draftStatus: DraftStatus): Promise<void> {
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(sendAttempts)
      .set({ status: "failed", error: error.slice(0, 1000) })
      .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM_CALL])))
      .returning({ id: sendAttempts.id });
    if (moved.length === 0) return;
    await tx
      .update(drafts)
      .set({ status: draftStatus, error: error.slice(0, 1000) })
      .where(and(eq(drafts.id, attempt.draftId), inArray(drafts.status, [...IN_FLIGHT_DRAFT_STATUSES])));
  });
}

/** The provider took the call and gave no answer. The send may have gone out, so nothing retries it until a person or the reconcile pass knows. */
export async function markAttemptUncertain(attempt: { id: string; draftId: string }, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(sendAttempts)
      .set({ status: "delivery_uncertain", error: error.slice(0, 1000) })
      .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM_CALL])))
      .returning({ id: sendAttempts.id });
    if (moved.length === 0) return;
    await tx
      .update(drafts)
      .set({ status: "delivery_uncertain", error: error.slice(0, 1000) })
      .where(and(eq(drafts.id, attempt.draftId), inArray(drafts.status, [...DRAFT_FROM.delivery_uncertain])));
  });
}

/** The channel's attempts that have not settled since `olderThan`, oldest first. An attempt with no provider is email's. */
export async function listUnsettledAttempts(channel: "email" | "linkedin", olderThan: Date, limit: number): Promise<AttemptRecord[]> {
  return db
    .select()
    .from(sendAttempts)
    .where(
      and(
        channel === "linkedin" ? eq(sendAttempts.provider, "linkedin") : sql`${sendAttempts.provider} is distinct from 'linkedin'`,
        inArray(sendAttempts.status, ["sending", "delivery_uncertain"]),
        sql`${sendAttempts.updatedAt} < ${olderThan.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(sendAttempts.createdAt)
    .limit(limit);
}
