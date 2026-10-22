import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, contactPolicies, conversations, drafts, events, linkedinAccounts, messages, people, records, sendAttempts, sends } from "@/platform/db/schema";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { LinkedInReplyContext, LinkedInReplyStore } from "../application/linkedin-reply-ports";
import type { AttemptRow } from "../application/reply-ports";
import { ATTEMPT_FROM, ATTEMPT_FROM_CALL, canMoveAttempt, type AttemptStatus } from "../domain/send-attempt-status";
import { replyBlock, replyGapSeconds, utcDayStart } from "../domain/linkedin-reply";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { IN_FLIGHT_DRAFT_STATUSES } from "../domain/draft-status";
import { draftCanBecome, draftIn } from "./reply-store-shared";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Attempts that sent or may have sent. A definite refusal used no quota. */
const COUNTED = ["sending", "sent", "delivery_uncertain", "reconciled"];

/** What the approval snapshot stores in `send_attempts.request` for a LinkedIn reply. */
interface Snapshot {
  channel: "linkedin";
  text: string;
  chat: string;
  accountId: string;
  providerAccountId: string;
  conversationId: string;
  recordId: string;
  personId: string;
  revision: number;
  expectedContextVersion: number;
}

const toAttempt = (a: typeof sendAttempts.$inferSelect): AttemptRow => ({
  id: a.id,
  draftId: a.draftId,
  status: a.status as AttemptRow["status"],
  error: a.error,
  rfcMessageId: null,
  providerMessageId: a.providerMessageId,
});

function contextFor(attempt: typeof sendAttempts.$inferSelect): LinkedInReplyContext {
  const snap = attempt.request as Snapshot;
  return {
    attempt: toAttempt(attempt),
    organizationId: attempt.organizationId,
    draftId: attempt.draftId,
    conversationId: snap.conversationId,
    recordId: snap.recordId,
    personId: snap.personId,
    accountId: snap.accountId,
    providerAccountId: snap.providerAccountId,
    chat: snap.chat,
    text: snap.text,
  };
}

async function usage(tx: Tx | typeof db, accountId: string, now: Date) {
  const dayStart = utcDayStart(now).toISOString();
  const [replies] = await tx
    .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${sendAttempts.createdAt})` })
    .from(sendAttempts)
    .where(and(eq(sendAttempts.provider, "linkedin"), eq(sendAttempts.accountRef, accountId), inArray(sendAttempts.status, COUNTED), sql`${sendAttempts.createdAt} >= ${dayStart}::timestamptz`));
  const [sequence] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sends)
    .where(and(eq(sends.linkedinAccountId, accountId), eq(sends.channel, "linkedin"), eq(sends.kind, "campaign"), sql`${sends.stepNumber} > 1`, inArray(sends.status, ["sending", "sent", "unknown"]), gte(sends.claimedAt, new Date(dayStart))));
  // Gap: the newest attempt of any size, including one that failed, so a burst of retries does not get through.
  const [latest] = await tx
    .select({ last: sql<Date | null>`max(${sendAttempts.createdAt})` })
    .from(sendAttempts)
    .where(and(eq(sendAttempts.provider, "linkedin"), eq(sendAttempts.accountRef, accountId)));
  return { usedToday: replies.n + sequence.n, lastAttemptAt: latest.last ? new Date(latest.last) : null };
}

async function gapFor(tx: Tx | typeof db, organizationId: string): Promise<number> {
  const [row] = await tx.select({ values: channelSettings.values }).from(channelSettings).where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "linkedin")));
  return replyGapSeconds(row?.values ?? null);
}

/** Marks the attempt and draft delivered, stores the outbound message and moves the record on. Runs inside a transaction. */
export async function settleLinkedInSent(tx: Tx, attemptId: string, sent: { providerMessageId: string | null }, now: Date, note?: string) {
  const [attempt] = await tx.select().from(sendAttempts).where(eq(sendAttempts.id, attemptId)).for("update");
  if (!attempt || !canMoveAttempt(attempt.status as AttemptStatus, note ? "reconciled" : "sent")) return;
  const snap = attempt.request as Snapshot;
  await tx
    .update(sendAttempts)
    .set({ status: note ? "reconciled" : "sent", providerMessageId: sent.providerMessageId, error: null, ...(note ? { reconciledAt: now, reconciliationNote: note } : {}) })
    .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM[note ? "reconciled" : "sent"]])));
  await tx.update(drafts).set({ status: "sent", error: null }).where(and(eq(drafts.id, attempt.draftId), draftCanBecome("sent")));

  const [account] = await tx.select({ name: linkedinAccounts.name, username: linkedinAccounts.username }).from(linkedinAccounts).where(eq(linkedinAccounts.id, snap.accountId));
  const [person] = await tx.select({ name: people.fullName, first: people.firstName }).from(people).where(eq(people.id, snap.personId));
  await tx
    .insert(messages)
    .values({
      organizationId: attempt.organizationId,
      conversationId: snap.conversationId,
      channel: "linkedin",
      accountRef: snap.accountId,
      direction: "outbound",
      idempotencyKey: `reply:${attempt.id}`,
      providerMessageId: sent.providerMessageId,
      fromAddress: account?.name ?? account?.username ?? "LinkedIn account",
      toAddress: person?.name ?? person?.first ?? null,
      bodyText: snap.text,
      raw: { draftId: attempt.draftId, attemptId: attempt.id, sentBy: attempt.actorUserId },
      sentAt: now,
    })
    .onConflictDoNothing();

  const at = sql`${now.toISOString()}::timestamptz`;
  await tx
    .update(records)
    .set({
      // A message that arrived while this reply was going out keeps the record waiting for a person.
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
    meta: { draftId: attempt.draftId, attemptId: attempt.id, channel: "linkedin", note: note ?? null },
  });
}

export const drizzleLinkedInReplyStore: LinkedInReplyStore = {
  async begin(input) {
    const result = await db.transaction(async (tx) => {
      // The conversation row serializes every reply to one chat: double clicks, two tabs, two workers.
      const [conv] = await tx
        .select({ id: conversations.id, recordId: conversations.recordId, channel: conversations.channel, status: conversations.status, accountRef: conversations.accountRef, chat: conversations.providerThreadId })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.organizationId), publicConversation))
        .for("update");
      if (!conv) throw new NotFoundError("Conversation not found");

      const [existing] = await tx
        .select({ attempt: sendAttempts, conversationId: drafts.conversationId })
        .from(sendAttempts)
        .innerJoin(drafts, eq(drafts.id, sendAttempts.draftId))
        .where(eq(sendAttempts.idempotencyKey, input.idempotencyKey));
      if (existing) {
        if (existing.conversationId !== conv.id || existing.attempt.organizationId !== input.organizationId) throw new ConflictError("This idempotency key belongs to another conversation.");
        return { kind: "replay" as const, attempt: toAttempt(existing.attempt) };
      }

      if (conv.channel !== "linkedin") throw new ConflictError("This is not a LinkedIn conversation.");
      if (conv.status !== "active") throw new ConflictError("This conversation is closed.");
      if (!conv.chat) throw new ConflictError("There is no LinkedIn chat for this conversation yet.");
      if (!UUID.test(conv.accountRef)) throw new ConflictError("No LinkedIn account is connected for this conversation.");

      const [inFlight] = await tx
        .select({ status: drafts.status })
        .from(drafts)
        .where(and(eq(drafts.conversationId, conv.id), draftIn(IN_FLIGHT_DRAFT_STATUSES)))
        .limit(1);
      if (inFlight) {
        throw new ConflictError(inFlight.status === "sending" ? "A reply is already being sent in this chat." : "An earlier reply in this chat has an unconfirmed outcome. Check LinkedIn and mark what you found first.");
      }

      const [record] = await tx.select({ personId: records.personId, version: records.contextVersion }).from(records).where(eq(records.id, conv.recordId));

      // A draft the person approves must still be the current one: not edited, not replaced, not older than the last message.
      let target: typeof drafts.$inferSelect | null = null;
      if (input.draft) {
        const [row] = await tx
          .select()
          .from(drafts)
          .where(and(eq(drafts.id, input.draft.id), eq(drafts.organizationId, input.organizationId), eq(drafts.conversationId, conv.id), eq(drafts.channel, "linkedin")))
          .for("update");
        if (!row) throw new NotFoundError("Draft not found");
        if (row.status === "stale") throw new ConflictError("A newer message arrived after this draft was written. Review the thread and regenerate the draft.");
        if (row.status !== "awaiting_review") throw new ConflictError(`This draft is ${row.status.replace(/_/g, " ")} and cannot be sent.`);
        if (row.revision !== input.draft.revision) throw new ConflictError("The draft changed since you reviewed it. Reload and approve the current text.");
        if (row.expectedContextVersion !== record.version) {
          await tx.update(drafts).set({ status: "stale", error: "A newer message arrived after this draft was written." }).where(and(eq(drafts.id, row.id), eq(drafts.status, "awaiting_review")));
          return { kind: "stale" as const };
        }
        target = row;
      }

      const [account] = await tx.select().from(linkedinAccounts).where(and(eq(linkedinAccounts.id, conv.accountRef), eq(linkedinAccounts.organizationId, input.organizationId))).for("update");
      if (!account) throw new ConflictError("No LinkedIn account is connected for this conversation.");
      const used = await usage(tx, account.id, input.now);
      const block = replyBlock(input.now, { status: account.status, limitReachedUntil: account.limitReachedUntil, dailyMessageLimit: account.dailyMessageLimit }, { ...used, gapSeconds: await gapFor(tx, input.organizationId) });
      if (block) throw new ConflictError(block.message, { code: block.reason, ...("retryAfterSeconds" in block ? { retryAfterSeconds: block.retryAfterSeconds } : {}) });

      // A refused earlier attempt left its text in an open draft. The new text replaces it.
      const [open] = target
        ? [target]
        : await tx
            .select()
            .from(drafts)
            .where(and(eq(drafts.conversationId, conv.id), eq(drafts.channel, "linkedin"), eq(drafts.status, "awaiting_review")))
            .orderBy(desc(drafts.createdAt))
            .limit(1)
            .for("update");
      let draftId: string;
      let revision: number;
      if (open) {
        const [updated] = await tx.update(drafts).set({ editedBodyText: input.text, revision: open.revision + 1, error: null, expectedContextVersion: record.version }).where(and(eq(drafts.id, open.id), eq(drafts.status, "awaiting_review"))).returning({ revision: drafts.revision });
        draftId = open.id;
        revision = updated.revision;
      } else {
        const [created] = await tx
          .insert(drafts)
          .values({
            organizationId: input.organizationId,
            recordId: conv.recordId,
            conversationId: conv.id,
            expectedContextVersion: record.version,
            channel: "linkedin",
            editedBodyText: input.text,
            status: "awaiting_review",
            provider: "human",
            request: { manual: true, createdBy: input.actorUserId },
          })
          .returning({ id: drafts.id, revision: drafts.revision });
        draftId = created.id;
        revision = created.revision;
      }

      const snapshot: Snapshot = {
        channel: "linkedin",
        text: input.text,
        chat: conv.chat,
        accountId: account.id,
        providerAccountId: account.providerAccountId,
        conversationId: conv.id,
        recordId: conv.recordId,
        personId: record.personId,
        revision,
        expectedContextVersion: record.version,
      };
      const [attempt] = await tx
        .insert(sendAttempts)
        .values({ organizationId: input.organizationId, draftId, idempotencyKey: input.idempotencyKey, status: "sending", actorUserId: input.actorUserId, provider: "linkedin", accountRef: account.id, request: snapshot })
        .returning();
      await tx.update(drafts).set({ status: "sending", error: null }).where(and(eq(drafts.id, draftId), draftCanBecome("sending")));
      return { kind: "started" as const, attempt };
    });
    if (result.kind === "stale") throw new ConflictError("A newer message arrived after this draft was written. Review the thread and regenerate the draft.");
    if (result.kind === "replay") return result;
    return { kind: "started", send: contextFor(result.attempt) };
  },

  async checkBlockers(send, now) {
    const [dnc] = await db.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, send.personId));
    if (dnc?.d) return { reason: "do_not_contact", message: "This person is marked do not contact. The reply was not sent." };
    const [account] = await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.id, send.accountId));
    // Pause and connection state only: the cap and the gap were applied by the claim.
    const block = account ? replyBlock(now, { status: account.status, limitReachedUntil: account.limitReachedUntil, dailyMessageLimit: Number.MAX_SAFE_INTEGER }, { usedToday: 0, lastAttemptAt: null, gapSeconds: 0 }) : { reason: "not_connected" as const, message: "This LinkedIn account no longer exists." };
    if (block && (block.reason === "not_connected" || block.reason === "paused")) return { reason: block.reason, message: `${block.message} The reply was not sent.` };
    return null;
  },

  async markSent(send, sent, now, note) {
    await db.transaction((tx) => settleLinkedInSent(tx, send.attempt.id, sent, now, note));
  },

  async markFailed(send, error) {
    await db.transaction(async (tx) => {
      // Compare-and-set: a late failure never overwrites sent, reconciled or an earlier failure.
      const moved = await tx
        .update(sendAttempts)
        .set({ status: "failed", error: error.slice(0, 1000) })
        .where(and(eq(sendAttempts.id, send.attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM_CALL])))
        .returning({ id: sendAttempts.id });
      if (moved.length === 0) return;
      await tx
        .update(drafts)
        .set({ status: "awaiting_review", error: error.slice(0, 1000) })
        .where(and(eq(drafts.id, send.draftId), draftIn(IN_FLIGHT_DRAFT_STATUSES)));
    });
  },

  async markUncertain(send, error) {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(sendAttempts)
        .set({ status: "delivery_uncertain", error: error.slice(0, 1000) })
        .where(and(eq(sendAttempts.id, send.attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM_CALL])))
        .returning({ id: sendAttempts.id });
      if (moved.length === 0) return;
      await tx
        .update(drafts)
        .set({ status: "delivery_uncertain", error: error.slice(0, 1000) })
        .where(and(eq(drafts.id, send.draftId), draftCanBecome("delivery_uncertain")));
    });
  },

  async pauseAccount(send, until) {
    await db.update(linkedinAccounts).set({ limitReachedUntil: until }).where(eq(linkedinAccounts.id, send.accountId));
  },

  async disconnectAccount(send, error) {
    await db
      .update(linkedinAccounts)
      .set({ status: "disconnected", profileData: sql`jsonb_set(coalesce(${linkedinAccounts.profileData}, '{}'::jsonb), '{lastError}', to_jsonb(${error}::text))` })
      .where(eq(linkedinAccounts.id, send.accountId));
  },

  async panel(organizationId, conversationId, now) {
    const [head] = await db
      .select({
        id: conversations.id,
        channel: conversations.channel,
        status: conversations.status,
        accountRef: conversations.accountRef,
        chat: conversations.providerThreadId,
        personId: people.id,
        name: people.fullName,
        firstName: people.firstName,
      })
      .from(conversations)
      .innerJoin(records, eq(records.id, conversations.recordId))
      .innerJoin(people, eq(people.id, records.personId))
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId), publicConversation));
    if (!head) return null;
    if (head.channel !== "linkedin") return null;

    const [account] = UUID.test(head.accountRef) ? await db.select().from(linkedinAccounts).where(and(eq(linkedinAccounts.id, head.accountRef), eq(linkedinAccounts.organizationId, organizationId))) : [];
    const [dnc] = await db.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, head.personId));
    const used = account ? await usage(db, account.id, now) : { usedToday: 0, lastAttemptAt: null };
    const block = account ? replyBlock(now, { status: account.status, limitReachedUntil: account.limitReachedUntil, dailyMessageLimit: account.dailyMessageLimit }, { ...used, gapSeconds: 0 }) : null;
    // The gap is a few seconds and clears by itself, so the panel does not show it.
    const issue = !account ? "No LinkedIn account is connected for this chat." : head.status !== "active" ? "This conversation is closed." : !head.chat ? "There is no LinkedIn chat for this conversation yet." : (block?.message ?? null);

    // The newest draft that was not discarded. A stale one stays visible, flagged, until a person replaces or discards it;
    // a sent one is history and shows nothing.
    const [newest] = await db
      .select()
      .from(drafts)
      .where(and(eq(drafts.conversationId, conversationId), eq(drafts.channel, "linkedin"), sql`${drafts.status} <> 'discarded'`))
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    const draft = newest && ["awaiting_review", "sending", "delivery_uncertain", "stale"].includes(newest.status) ? newest : null;
    return {
      conversationId,
      recipient: head.name ?? head.firstName,
      accountLabel: account?.name ?? account?.username ?? "LinkedIn account",
      issue,
      doNotContact: dnc?.d === true,
      usedToday: used.usedToday,
      dailyLimit: account?.dailyMessageLimit ?? 0,
      draft: draft
        ? { id: draft.id, status: draft.status, text: draft.editedBodyText ?? draft.aiBodyText ?? "", error: draft.error, revision: draft.revision, source: (draft.request as { manual?: boolean } | null)?.manual === true ? "manual" : "ai" }
        : null,
    };
  },

  async listUnsettled(olderThan, limit) {
    const rows = await db
      .select()
      .from(sendAttempts)
      .where(and(eq(sendAttempts.provider, "linkedin"), inArray(sendAttempts.status, ["sending", "delivery_uncertain"]), sql`${sendAttempts.updatedAt} < ${olderThan.toISOString()}::timestamptz`))
      .orderBy(sendAttempts.createdAt)
      .limit(limit);
    return rows.map((a) => ({ send: contextFor(a), status: a.status as "sending" | "delivery_uncertain", startedAt: a.createdAt }));
  },
};
