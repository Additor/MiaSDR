import { and, eq, sql } from "drizzle-orm";
import { findOrCreateLeadByLinkedInTx } from "@/contexts/people/infrastructure/inbound-leads";
import { db } from "@/platform/db/client";
import { conversations, messages, people, records } from "@/platform/db/schema";
import type { InboundLinkedInInput, InboundLinkedInStore } from "../application/linkedin-ports";
import { defaultReplyTypeSetId, findOrCreateRecord, type Tx } from "./drizzle-conversation-store";
import { stopPersonOutreachOnReplyTx } from "../after-reply/infrastructure/sequence-stop";
import { autoAssignTx } from "../actions/infrastructure/assignment-sql";
import { staleOpenDraftsTx } from "./stale-drafts-sql";
import { detachPrivateThreadTx } from "./private-thread-detach";

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

export const drizzleLinkedInConversationStore: InboundLinkedInStore = {
  async ingestLinkedIn(input) {
    return db.transaction(async (tx) => {
      const idempotencyKey = `linkedin:${input.accountRef}:${input.providerMessageId}`;
      const messageScope = and(eq(messages.channel, "linkedin"), eq(messages.accountRef, input.accountRef), eq(messages.idempotencyKey, idempotencyKey));

      const [stored] = await tx
        .select({ id: messages.id, conversationId: messages.conversationId, personId: records.personId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(records, eq(records.id, conversations.recordId))
        .where(messageScope);
      if (stored) {
        return { status: "duplicate" as const, conversationId: stored.conversationId, messageId: stored.id, personId: stored.personId, personCreated: false };
      }

      const threadScope = and(
        eq(conversations.channel, "linkedin"),
        eq(conversations.accountRef, input.accountRef),
        eq(conversations.providerThreadId, input.providerThreadId),
      );
      const findConversation = async () =>
        (await tx.select({ id: conversations.id, recordId: conversations.recordId, organizationId: conversations.organizationId, privateCampaignId: conversations.privateCampaignId }).from(conversations).where(threadScope))[0];

      // A message in a known chat joins that conversation.
      let conversation = await findConversation();
      let personCreated = false;
      if (!conversation) {
        const person = await resolvePerson(tx, input);
        if (!person) {
          return {
            status: "unresolved" as const,
            reason: "LinkedIn message has no known lead and no public profile identity",
            identityValue: input.counterparty.providerId,
          };
        }
        personCreated = person.created;
        const recordId = await findOrCreateRecord(tx, input.organizationId, person.id, await defaultReplyTypeSetId(tx, input.organizationId));
        await tx
          .insert(conversations)
          .values({
            organizationId: input.organizationId,
            recordId,
            channel: "linkedin",
            accountRef: input.accountRef,
            providerThreadId: input.providerThreadId,
            providerContactId: input.counterparty.providerId,
            privateCampaignId: input.privateCampaignId ?? null,
          })
          .onConflictDoNothing();
        conversation = await findConversation();
      }
      if (conversation.organizationId !== input.organizationId) {
        throw new Error(`Chat ${input.providerThreadId} on account ${input.accountRef} belongs to another organization.`);
      }
      // A reply of a personal-campaign lead makes the thread private for good, even when a public thread existed before.
      if (input.privateCampaignId && !conversation.privateCampaignId) {
        await tx.update(conversations).set({ privateCampaignId: input.privateCampaignId }).where(eq(conversations.id, conversation.id));
        conversation = { ...conversation, privateCampaignId: input.privateCampaignId };
        // The thread already moved the shared record while it was public. Undo that in this transaction.
        await detachPrivateThreadTx(tx, { organizationId: input.organizationId, conversationId: conversation.id, recordId: conversation.recordId, now: new Date() });
      }
      const isPrivate = conversation.privateCampaignId !== null;

      const [owner] = await tx
        .select({ personId: records.personId, fullName: people.fullName, firstName: people.firstName, slug: people.linkedinSlug })
        .from(records)
        .innerJoin(people, eq(people.id, records.personId))
        .where(eq(records.id, conversation.recordId));
      const sender = input.counterparty.name ?? owner.fullName ?? owner.firstName ?? input.counterparty.profileUrl ?? "LinkedIn member";

      const [message] = await tx
        .insert(messages)
        .values({
          organizationId: input.organizationId,
          conversationId: conversation.id,
          channel: "linkedin",
          accountRef: input.accountRef,
          direction: "inbound",
          idempotencyKey,
          providerMessageId: input.providerMessageId,
          fromAddress: sender,
          toAddress: input.accountName,
          bodyText: input.bodyText,
          raw: { memberId: input.counterparty.providerId, profileUrl: input.counterparty.profileUrl },
          sentAt: input.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });

      if (!message) {
        // Lost a race with another worker that stored the same message.
        const [winner] = await tx.select({ id: messages.id }).from(messages).where(messageScope);
        return { status: "duplicate" as const, conversationId: conversation.id, messageId: winner.id, personId: owner.personId, personCreated: false };
      }

      // A private thread leaves the record alone: no workflow state, version bump or latest-inbound pointer, so no
      // classification job, draft, task or stage movement can follow. Only the outreach stop below still runs.
      if (!isPrivate) {
        const at = sql`${input.receivedAt.toISOString()}::timestamptz`;
        const newest = sql`${records.lastInboundAt} is null or ${records.lastInboundAt} <= ${at}`;
        await tx
          .update(records)
          .set({
            workflowState: "action_required",
            activeChannel: "linkedin",
            contextVersion: sql`${records.contextVersion} + 1`,
            latestInboundMessageId: sql`case when ${newest} then ${message.id}::uuid else ${records.latestInboundMessageId} end`,
            lastInboundAt: sql`greatest(coalesce(${records.lastInboundAt}, ${at}), ${at})`,
            lastInteractionAt: sql`greatest(coalesce(${records.lastInteractionAt}, ${at}), ${at})`,
          })
          .where(eq(records.id, conversation.recordId));
        await staleOpenDraftsTx(tx, { organizationId: input.organizationId, recordId: conversation.recordId, reason: "A newer message arrived after this draft was written.", now: new Date() });
        await autoAssignTx(tx, { organizationId: input.organizationId, recordId: conversation.recordId, personId: owner.personId });
      }
      // A reply ends all outreach to the person, on every channel and campaign, in the same transaction.
      const stop = await stopPersonOutreachOnReplyTx(tx, { organizationId: input.organizationId, personId: owner.personId, channel: "linkedin", now: new Date() });
      await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, conversation.id));

      return { status: "created" as const, conversationId: conversation.id, messageId: message.id, personId: owner.personId, personCreated, outreachStopped: stop.enrollmentsStopped };
    });
  },
};
