import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { settleLinkedInSent } from "./drizzle-linkedin-reply-store";
import { contactPolicies, conversations, drafts, events, mailboxes, messages, people, records, sendAttempts, sends, suppressionList } from "@/platform/db/schema";
import { ConflictError, NotFoundError } from "@/shared/errors";
import type { BeginSend, ReplyStore } from "../application/reply-ports";
import { ATTEMPT_FROM, ATTEMPT_FROM_CALL } from "../domain/send-attempt-status";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { toAttempt, type Snapshot, mailboxFor, sendContextFor, settleSent, blockedAddressesFor, draftCanBecome, draftIn } from "./reply-store-shared";
import { IN_FLIGHT_DRAFT_STATUSES } from "../domain/draft-status";

/** Sending an approved draft and settling the outcome: claim, blockers, sent, failed, uncertain, and the reconcile pass. */
export const replySendMethods: Pick<ReplyStore, "beginSend" | "checkBlockers" | "markSent" | "markFailed" | "markUncertain" | "listUnsettled" | "resolveUncertain"> = {
  async beginSend(input): Promise<BeginSend> {
    const result = await db.transaction(async (tx) => {
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, input.draftId), eq(drafts.organizationId, input.organizationId))).for("update");
      if (!draft) throw new NotFoundError("Draft not found");

      const [existing] = await tx.select().from(sendAttempts).where(eq(sendAttempts.idempotencyKey, input.idempotencyKey));
      if (existing) {
        if (existing.draftId !== draft.id || existing.organizationId !== input.organizationId) throw new ConflictError("This idempotency key belongs to another draft.");
        return { kind: "replay" as const, attempt: toAttempt(existing) };
      }
      if (draft.status !== "awaiting_review") throw new ConflictError(`This draft is ${draft.status.replace(/_/g, " ")} and cannot be sent.`);
      if (draft.revision !== input.expectedRevision) throw new ConflictError("The draft changed since you reviewed it. Reload and approve the current text.");

      const [ctx] = await tx
        .select({
          recordId: records.id,
          personId: records.personId,
          version: records.contextVersion,
          email: people.email,
          conversationStatus: conversations.status,
          channel: conversations.channel,
          accountRef: conversations.accountRef,
          threadId: conversations.providerThreadId,
        })
        .from(conversations)
        .innerJoin(records, eq(records.id, conversations.recordId))
        .innerJoin(people, eq(people.id, records.personId))
        .where(and(eq(conversations.id, draft.conversationId), publicConversation));
      if (!ctx || ctx.channel !== "email") throw new ConflictError("Replies can only be sent on email conversations.");
      if (ctx.version !== draft.expectedContextVersion) {
        await tx.update(drafts).set({ status: "stale", error: "A newer message arrived after this draft was written." }).where(and(eq(drafts.id, draft.id), eq(drafts.status, "awaiting_review")));
        return { kind: "stale" as const };
      }
      if (ctx.conversationStatus !== "active") throw new ConflictError("This conversation is closed.");
      if (!ctx.email) throw new ConflictError("This person has no email address.");
      const body = (draft.editedBodyText ?? draft.aiBodyText ?? "").trim();
      if (body === "") throw new ConflictError("The draft is empty.");

      // Message ids of everything already in the thread, oldest first, for In-Reply-To and References.
      const stored = await tx
        .select({ id: messages.id, raw: messages.raw, sentAt: messages.sentAt })
        .from(messages)
        .where(eq(messages.conversationId, draft.conversationId))
        .orderBy(messages.sentAt);
      const rfcOf = (raw: unknown) => ((raw ?? {}) as { rfcMessageId?: string | null }).rfcMessageId ?? null;
      const sequenceIds = ctx.threadId
        ? (
            await tx
              .select({ rfc: sends.rfcMessageId })
              .from(sends)
              .innerJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
              .where(and(eq(sends.organizationId, input.organizationId), eq(sends.status, "sent"), eq(sends.threadId, ctx.threadId), sql`lower(${mailboxes.emailAddress}) = ${ctx.accountRef}`))
              .orderBy(sends.sentAt)
          )
            .map((r) => r.rfc)
            .filter((r): r is string => Boolean(r))
        : [];
      const references = [...new Set([...sequenceIds, ...stored.map((m) => rfcOf(m.raw)).filter((r): r is string => Boolean(r))])];
      const anchor = draft.replyForMessageId ? rfcOf(stored.find((m) => m.id === draft.replyForMessageId)?.raw) : null;
      const inReplyTo = anchor ?? references.at(-1) ?? null;

      const domain = ctx.accountRef.split("@")[1] ?? "miasdr.local";
      const rfcMessageId = `<${input.messageIdToken}@${domain}>`;
      const snapshot: Snapshot = {
        rfcMessageId,
        to: ctx.email,
        cc: draft.cc,
        subject: draft.subject?.trim() || "Re: your message",
        bodyText: body,
        accountRef: ctx.accountRef,
        conversationId: draft.conversationId,
        recordId: ctx.recordId,
        personId: ctx.personId,
        threadId: ctx.threadId,
        inReplyTo,
        references,
        revision: draft.revision,
        expectedContextVersion: draft.expectedContextVersion,
      };
      const [attempt] = await tx
        .insert(sendAttempts)
        .values({
          organizationId: input.organizationId,
          draftId: draft.id,
          idempotencyKey: input.idempotencyKey,
          status: "sending",
          actorUserId: input.actorUserId,
          provider: "mailbox",
          accountRef: ctx.accountRef,
          request: snapshot,
        })
        .returning();
      await tx.update(drafts).set({ status: "sending", error: null }).where(and(eq(drafts.id, draft.id), draftCanBecome("sending")));
      return { kind: "started" as const, attempt, snapshot };
    });

    if (result.kind === "stale") throw new ConflictError("A newer message arrived after this draft was written. Review the thread and regenerate the draft.");
    if (result.kind === "replay") return result;
    return { kind: "started", send: await sendContextFor(result.attempt) };
  },

  async checkBlockers(send) {
    const email = send.recipient.toLowerCase();
    const [suppressed] = await db.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.organizationId, send.organizationId), eq(suppressionList.email, email)));
    if (suppressed) return "suppressed";
    const [dnc] = await db.select({ d: contactPolicies.doNotContact }).from(contactPolicies).where(eq(contactPolicies.personId, send.personId));
    if (dnc?.d) return "do_not_contact";
    // Suppression and do-not-contact apply to every recipient, not only the lead.
    if (send.cc.length > 0 && (await blockedAddressesFor(send.organizationId, send.cc)).length > 0) return "cc_blocked";
    const mailbox = await mailboxFor(send.organizationId, send.mailbox?.emailAddress ?? "");
    if (!mailbox || mailbox.status !== "connected") return "mailbox_unavailable";
    return null;
  },

  async markSent(send, sent, now, note) {
    await db.transaction((tx) => settleSent(tx, send, sent, now, note));
  },

  async markFailed(send, error, draftStatus) {
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
        .set({ status: draftStatus, error: error.slice(0, 1000) })
        .where(and(eq(drafts.id, send.attempt.draftId), draftIn(IN_FLIGHT_DRAFT_STATUSES)));
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
        .where(and(eq(drafts.id, send.attempt.draftId), draftCanBecome("delivery_uncertain")));
    });
  },

  async listUnsettled(olderThan, limit) {
    const rows = await db
      .select()
      .from(sendAttempts)
      .where(and(sql`${sendAttempts.provider} is distinct from 'linkedin'`, inArray(sendAttempts.status, ["sending", "delivery_uncertain"]), sql`${sendAttempts.updatedAt} < ${olderThan.toISOString()}::timestamptz`))
      .orderBy(sendAttempts.createdAt)
      .limit(limit);
    return Promise.all(rows.map(async (a) => ({ send: await sendContextFor(a), status: a.status as "sending" | "delivery_uncertain", startedAt: a.createdAt })));
  },

  async resolveUncertain(input) {
    await db.transaction(async (tx) => {
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, input.draftId), eq(drafts.organizationId, input.organizationId))).for("update");
      if (!draft) throw new NotFoundError("Draft not found");
      if (draft.status !== "delivery_uncertain") throw new ConflictError("Only a send with an uncertain outcome can be resolved.");
      const [attempt] = await tx.select().from(sendAttempts).where(and(eq(sendAttempts.draftId, draft.id), eq(sendAttempts.status, "delivery_uncertain"))).for("update");
      if (!attempt) throw new ConflictError("No uncertain send was found for this draft.");
      if (input.outcome === "delivered") {
        if (attempt.provider === "linkedin") {
          await settleLinkedInSent(tx, attempt.id, { providerMessageId: null }, input.now, `Confirmed delivered by a person: ${input.note}`);
          return;
        }
        await settleSent(tx, await sendContextFor(attempt), { providerMessageId: null, threadId: null }, input.now, `Confirmed delivered by a person: ${input.note}`);
        return;
      }
      const snap = attempt.request as Snapshot;
      await tx
        .update(sendAttempts)
        .set({ status: "failed", reconciledAt: input.now, reconciliationNote: `Marked not delivered by a person: ${input.note}` })
        .where(and(eq(sendAttempts.id, attempt.id), inArray(sendAttempts.status, [...ATTEMPT_FROM.failed])));
      await tx.update(drafts).set({ status: "failed", error: `Marked not delivered: ${input.note}` }).where(and(eq(drafts.id, draft.id), draftIn(IN_FLIGHT_DRAFT_STATUSES)));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: snap.personId,
        recordId: snap.recordId,
        eventType: "draft.not_delivered",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { draftId: draft.id, attemptId: attempt.id, note: input.note },
      });
    });
  },
};
