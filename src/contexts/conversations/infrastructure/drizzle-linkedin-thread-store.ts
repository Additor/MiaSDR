import { and, eq, sql } from "drizzle-orm";
import { findOrCreateLeadByLinkedInTx } from "@/contexts/people/infrastructure/inbound-leads";
import { db } from "@/platform/db/client";
import { threads, messages, people, conversations } from "@/platform/db/schema";
import type { InboundLinkedInInput, InboundLinkedInStore } from "../application/linkedin-ports";
import { detectsStopRequest } from "../domain/stop-request";
import { defaultReplyTypeSetId, findOrCreateConversation, type Tx } from "./drizzle-thread-store";
import { stopPersonOutreachOnReplyTx } from "../after-reply/infrastructure/follow-up-stop";
import { autoAssignTx } from "../actions/infrastructure/assignment-sql";
import { recordInboundTx } from "./conversation-context";

/**
 * The lead the message belongs to: the one the caller named, then the one with this profile slug, else a
 * new inbound person. A sender with no slug cannot be told apart from anyone else, so the result is
 * `null` and the caller parks the message instead of inventing a nameless person.
 */
async function resolvePerson(tx: Tx, input: InboundLinkedInInput) {
  if (input.personId) {
    const [known] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, input.personId), eq(people.organizationId, input.organizationId)));
    if (known) return { id: known.id, created: false };
  }
  const { slug, name } = input.counterparty;
  if (!slug) return null;
  return findOrCreateLeadByLinkedInTx(tx, input.organizationId, { slug, name });
}

export const drizzleLinkedInThreadStore: InboundLinkedInStore = {
  async ingestLinkedIn(input) {
    return db.transaction(async (tx) => {
      const idempotencyKey = `linkedin:${input.accountRef}:${input.providerMessageId}`;
      const messageScope = and(eq(messages.organizationId, input.organizationId), eq(messages.channel, "linkedin"), eq(messages.accountRef, input.accountRef), eq(messages.idempotencyKey, idempotencyKey));

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
        eq(threads.channel, "linkedin"),
        eq(threads.accountRef, input.accountRef),
        eq(threads.providerThreadId, input.providerThreadId),
      );
      const findThread = async () =>
        (await tx.select({ id: threads.id, conversationId: threads.conversationId }).from(threads).where(threadScope))[0];

      // A message in a known chat joins that conversation.
      let thread = await findThread();
      let personCreated = false;
      if (!thread) {
        const person = await resolvePerson(tx, input);
        if (!person) {
          return {
            status: "unresolved" as const,
            reason: "LinkedIn message has no known lead and no public profile identity",
            identityValue: input.counterparty.providerId,
          };
        }
        personCreated = person.created;
        const conversationId = await findOrCreateConversation(tx, input.organizationId, person.id, await defaultReplyTypeSetId(tx, input.organizationId));
        await tx
          .insert(threads)
          .values({
            organizationId: input.organizationId,
            conversationId,
            channel: "linkedin",
            accountRef: input.accountRef,
            providerThreadId: input.providerThreadId,
            providerContactId: input.counterparty.providerId,
          })
          .onConflictDoNothing();
        thread = await findThread();
      }

      const [owner] = await tx
        .select({ personId: conversations.personId, fullName: people.fullName, firstName: people.firstName, slug: people.linkedinSlug })
        .from(conversations)
        .innerJoin(people, eq(people.id, conversations.personId))
        .where(eq(conversations.id, thread.conversationId));
      const sender = input.counterparty.name ?? owner.fullName ?? owner.firstName ?? input.counterparty.profileUrl ?? "LinkedIn member";

      const [message] = await tx
        .insert(messages)
        .values({
          organizationId: input.organizationId,
          threadId: thread.id,
          channel: "linkedin",
          accountRef: input.accountRef,
          direction: "inbound",
          idempotencyKey,
          providerMessageId: input.providerMessageId,
          fromAddress: sender,
          toAddress: input.accountName,
          bodyText: input.bodyText,
          raw: { memberId: input.counterparty.providerId, profileUrl: input.counterparty.profileUrl, ...(detectsStopRequest(input.bodyText) ? { stopAsked: true } : {}) },
          sentAt: input.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });

      if (!message) {
        // Lost a race with another worker that stored the same message.
        const [winner] = await tx.select({ id: messages.id }).from(messages).where(messageScope);
        return { status: "duplicate" as const, threadId: thread.id, messageId: winner.id, personId: owner.personId, personCreated: false };
      }

      const at = sql`${input.receivedAt.toISOString()}::timestamptz`;
      await recordInboundTx(tx, { organizationId: input.organizationId, conversationId: thread.conversationId, channel: "linkedin", messageId: message.id, at, now: new Date() });
      await autoAssignTx(tx, { organizationId: input.organizationId, conversationId: thread.conversationId, personId: owner.personId });
      // A reply ends all outreach to the person, on every channel and campaign, in the same transaction.
      const stop = await stopPersonOutreachOnReplyTx(tx, { organizationId: input.organizationId, personId: owner.personId, channel: "linkedin", now: new Date() });
      await tx.update(threads).set({ updatedAt: sql`now()` }).where(eq(threads.id, thread.id));

      return { status: "created" as const, threadId: thread.id, messageId: message.id, personId: owner.personId, personCreated, outreachStopped: stop.enrollmentsStopped };
    });
  },
};
