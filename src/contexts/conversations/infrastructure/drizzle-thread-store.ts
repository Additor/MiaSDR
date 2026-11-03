import { and, eq, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { threads, leadCcs, mailboxes, messages, people, replyTypeSets, replyHandlingSettings, conversations, replyTypes } from "@/platform/db/schema";
import { DEFAULT_TYPE_SET_NAME, DEFAULT_REPLY_TYPES } from "../domain/default-reply-types";
import { detectsStopRequest } from "../stopping/domain/stop-request";
import { inboundCcCandidates, normalizeCcList } from "../domain/lead-cc";
import type { InboundThreadStore, InboundEmailInput } from "../application/ports";
import { stopContactTx } from "../stopping/infrastructure/stop-contact";
import { autoAssignTx } from "../actions/infrastructure/assignment-sql";
import { recordInboundTx } from "./conversation-context";
import { findOrCreateLeadByEmailTx } from "@/contexts/people/infrastructure/inbound-leads";

export type Tx = DbTx;

/** The organization's default reply type set, created with its settings and starter reply types on first use. */
export async function defaultReplyTypeSetId(tx: Tx, organizationId: string): Promise<string> {
  const find = async () =>
    (await tx.select({ id: replyTypeSets.id }).from(replyTypeSets).where(and(eq(replyTypeSets.organizationId, organizationId), eq(replyTypeSets.isDefault, true))))[0]?.id;
  const existing = await find();
  if (existing) return existing;

  // A concurrent first message loses the insert race and reads the winner's row.
  const [created] = await tx
    .insert(replyTypeSets)
    .values({ organizationId, name: DEFAULT_TYPE_SET_NAME, isDefault: true })
    .onConflictDoNothing()
    .returning({ id: replyTypeSets.id });
  if (!created) {
    const winner = await find();
    if (winner) return winner;
    throw new Error(`Could not create the default reply type set: another set is already named "${DEFAULT_TYPE_SET_NAME}".`);
  }
  await tx.insert(replyHandlingSettings).values({ replyTypeSetId: created.id, organizationId });
  await tx.insert(replyTypes).values(
    DEFAULT_REPLY_TYPES.map((s, index) => ({
      organizationId,
      replyTypeSetId: created.id,
      groupKey: s.groupKey,
      key: s.key,
      name: s.name,
      description: s.description,
      classificationGuidance: s.classificationGuidance,
      replyDraft: s.rules.replyDraft,
      followUps: s.rules.followUps,
      systemRole: s.systemRole ?? null,
      sortOrder: index,
    })),
  );
  return created.id;
}

export async function findOrCreateConversation(tx: Tx, organizationId: string, personId: string, replyTypeSetId: string): Promise<string> {
  await tx.insert(conversations).values({ organizationId, personId, replyTypeSetId }).onConflictDoNothing();
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.personId, personId), eq(conversations.replyTypeSetId, replyTypeSetId)));
  return row.id;
}

/** Every mailbox address of the organization, lowercased, whatever its status. None of them is ever a CC suggestion. */
export async function organizationMailboxAddresses(organizationId: string): Promise<string[]> {
  const rows = await db.select({ email: mailboxes.emailAddress }).from(mailboxes).where(eq(mailboxes.organizationId, organizationId));
  return rows.map((r) => r.email.trim().toLowerCase());
}

/**
 * Remembers the CC addresses of an inbound message for the lead. One row per person and address, so the
 * same message or the same address on a later message updates `last_seen_at` instead of adding rows.
 * Nothing here enrolls or emails anyone.
 */
async function rememberCcs(tx: Tx, input: InboundEmailInput, messageId: string, personId: string) {
  if (!input.cc?.length) return;
  const [person] = await tx.select({ email: people.email }).from(people).where(and(eq(people.id, personId), eq(people.organizationId, input.organizationId)));
  const addresses = inboundCcCandidates(input.cc, { mailbox: input.accountRef, lead: person?.email, sender: input.from.email, others: await organizationMailboxAddresses(input.organizationId) });
  if (addresses.length === 0) return;
  await tx
    .insert(leadCcs)
    .values(addresses.map((email) => ({ organizationId: input.organizationId, personId, email, firstSeenAt: input.receivedAt, lastSeenAt: input.receivedAt, sourceMessageId: messageId })))
    .onConflictDoUpdate({
      target: [leadCcs.personId, leadCcs.email],
      set: {
        // An older message replayed late must not move the pointer backwards.
        lastSeenAt: sql`greatest(${leadCcs.lastSeenAt}, excluded.last_seen_at)`,
        sourceMessageId: sql`case when excluded.last_seen_at >= ${leadCcs.lastSeenAt} then excluded.source_message_id else ${leadCcs.sourceMessageId} end`,
        firstSeenAt: sql`least(${leadCcs.firstSeenAt}, excluded.first_seen_at)`,
      },
    });
}

export const drizzleThreadStore: InboundThreadStore = {
  async ingestEmail(input: InboundEmailInput) {
    return db.transaction(async (tx) => {
      const idempotencyKey = `gmail:${input.accountRef}:${input.providerMessageId}`;
      const messageScope = and(eq(messages.organizationId, input.organizationId), eq(messages.channel, "email"), eq(messages.accountRef, input.accountRef), eq(messages.idempotencyKey, idempotencyKey));

      const [stored] = await tx
        .select({ id: messages.id, threadId: messages.threadId, personId: conversations.personId })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(conversations, eq(conversations.id, threads.conversationId))
        .where(messageScope);
      if (stored) {
        return { status: "duplicate" as const, threadId: stored.threadId, messageId: stored.id, personId: stored.personId, personCreated: false };
      }

      const threadScope = and(
        eq(threads.organizationId, input.organizationId),
        eq(threads.channel, "email"),
        eq(threads.accountRef, input.accountRef),
        eq(threads.providerThreadId, input.providerThreadId),
      );
      const findThread = async () =>
        (await tx.select({ id: threads.id, conversationId: threads.conversationId }).from(threads).where(threadScope))[0];

      // A reply in a known thread joins that conversation, whoever sent it.
      let thread = await findThread();
      let personCreated = false;
      if (!thread) {
        const chosen = input.personId
          ? (await tx.select({ id: people.id }).from(people).where(and(eq(people.id, input.personId), eq(people.organizationId, input.organizationId))))[0]
          : undefined;
        if (input.personId && !chosen) throw new Error(`Person ${input.personId} is not in organization ${input.organizationId}.`);
        const person = chosen ? { id: chosen.id, created: false } : await findOrCreateLeadByEmailTx(tx, input.organizationId, input.from);
        personCreated = person.created;
        const conversationId = await findOrCreateConversation(tx, input.organizationId, person.id, await defaultReplyTypeSetId(tx, input.organizationId));
        await tx
          .insert(threads)
          .values({ organizationId: input.organizationId, conversationId, channel: "email", accountRef: input.accountRef, providerThreadId: input.providerThreadId })
          .onConflictDoNothing();
        thread = await findThread();
      }

      const [message] = await tx
        .insert(messages)
        .values({
          organizationId: input.organizationId,
          threadId: thread.id,
          channel: "email",
          accountRef: input.accountRef,
          direction: "inbound",
          idempotencyKey,
          providerMessageId: input.providerMessageId,
          subject: input.subject || null,
          fromAddress: input.from.email,
          toAddress: input.to.join(", ") || null,
          bodyText: input.bodyText,
          raw: { autoReply: input.autoReply, ...(detectsStopRequest(input.bodyText) ? { stopAsked: true } : {}), rfcMessageId: input.rfcMessageId, inReplyTo: input.inReplyTo, fromName: input.from.name, ...(input.cc?.length ? { cc: normalizeCcList(input.cc) } : {}), ...(input.possibleBounce ? { possibleBounce: true } : {}) },
          sentAt: input.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });

      const [conversation] = await tx
        .select({ personId: conversations.personId })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));

      if (!message) {
        // Lost a race with another worker that stored the same message.
        const [winner] = await tx.select({ id: messages.id }).from(messages).where(messageScope);
        return { status: "duplicate" as const, threadId: thread.id, messageId: winner.id, personId: conversation.personId, personCreated: false };
      }

      if (!input.autoReply) await rememberCcs(tx, input, message.id, conversation.personId);

      const at = sql`${input.receivedAt.toISOString()}::timestamptz`;
      let outreachStopped = 0;
      if (input.autoReply) {
        // An automatic reply is history, not a request: no state change, no AI context bump.
        await tx
          .update(conversations)
          .set({ lastInteractionAt: sql`greatest(coalesce(${conversations.lastInteractionAt}, ${at}), ${at})` })
          .where(eq(conversations.id, thread.conversationId));
      } else {
        await recordInboundTx(tx, { organizationId: input.organizationId, conversationId: thread.conversationId, channel: "email", messageId: message.id, at, now: new Date() });
        // A genuine reply ends all outreach to the person, on every channel and campaign, in the same transaction. The
        // sender's address is matched too, so mail without thread headers from a lead still stops their enrollments.
        const stop = await stopContactTx(tx, { organizationId: input.organizationId, personId: conversation.personId, senderEmail: input.from.email }, { kind: "reply", channel: "email", now: new Date() });
        outreachStopped = stop.enrollments;
        // A reply that finds the conversation unassigned goes to the person who ran the campaign. A person's choice is never replaced.
        await autoAssignTx(tx, { organizationId: input.organizationId, conversationId: thread.conversationId, personId: conversation.personId });
      }
      await tx.update(threads).set({ updatedAt: sql`now()` }).where(eq(threads.id, thread.id));

      return { status: "created" as const, threadId: thread.id, messageId: message.id, personId: conversation.personId, personCreated, outreachStopped };
    });
  },
};
