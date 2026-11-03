import { pickMayBecome } from "./reply-store-shared";
import { isAppliedPick, pickFlags, pickResponse } from "../domain/reply-type-pick";
import { violatedConstraint } from "@/platform/db/errors";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { interruptPersonRunsTx } from "../after-reply/infrastructure/follow-up-stop";
import { personReviewedStopsTx } from "./stop-review";
import { stopReviewOpen } from "./stop-requested-sql";
import { personTypeDecisionTx, restartConversationWorkTx } from "./restart-conversation-work";
import {
  aiJobs,
  campaignEnrollments,
  campaigns,
  replyTypePicks,
  companies,
  contactPolicies,
  threads,
  drafts,
  events,
  identityExceptions,
  messages,
  notes,
  people,
  replyHandlingSettings,
  conversations,
  sendAttempts,
  replyTypes,
  users,
} from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError, viaMeta } from "@/shared/errors";
import type {
  ReplyTypePickEntry,
  ReplyHandlingStore,
  DncResult,
  DraftEntry,
  EventEntry,
  NoteEntry,
  ConversationDetail,
  ReplyHandlingSettingsRow,
  ReplyTypeCatalog,
} from "../application/reply-handling-ports";
import { byGroupThenOrder, checkReplyTypeChange, lockBeforePick, type ReplyTypeGroup } from "../domain/reply-handling";
import { afterPersonDecision, afterReopen, afterTypeChange, type WorkflowState } from "../domain/workflow-state";
import { MARKED_DONE } from "../domain/reply-send";
import { holdReasonOf, typeRulesOf, type TypeRules } from "../domain/reply-type";
import { replyTypeOption, typeChangeFactsOf } from "./type-change-facts-read";
import { defaultReplyTypeSetId, type Tx } from "./drizzle-thread-store";
import { advanceConversationContextTx } from "./conversation-context";
import { haltPersonEnrollmentsTx } from "@/contexts/outreach/infrastructure/enrollment-end";
import { isSuppressed, writeDoNotContactTx } from "@/contexts/people/infrastructure/reachability";
import { rowsOf } from "@/platform/db/sql-values";

const personName = (p: { fullName: string | null; firstName: string | null }) => p.fullName ?? p.firstName;

async function replyTypeSetFor(organizationId: string) {
  return db.transaction(async (tx) => {
    const id = await defaultReplyTypeSetId(tx, organizationId);
    const settings = (await tx.select().from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, id)))[0];
    if (!settings) await tx.insert(replyHandlingSettings).values({ replyTypeSetId: id, organizationId }).onConflictDoNothing();
    return id;
  });
}

/** The AI instructions of a set. `replyTypeSetFor` makes sure the row exists. */
async function settingsOf(replyTypeSetId: string): Promise<ReplyHandlingSettingsRow> {
  const [settings] = await db.select().from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, replyTypeSetId));
  return {
    draftInstructions: settings.draftInstructions,
    classificationInstructions: settings.classificationInstructions,
  };
}

/**
 * Locks a conversation of the organization. No key update: a writer lock that lets a draft insert's foreign key check (a key share) through (docs/database.md,
 * "Lock modes").
 */
async function lockConversation(tx: Tx, organizationId: string, conversationId: string) {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .for("no key update");
  if (!row) throw new NotFoundError("Reply handling not found");
  return row;
}

/**
 * Do not contact reads the people row without a lock, so a contact delete can commit between that read and the
 * `contact_policies` upsert or an event insert. The person foreign key then refuses the write (23503), which means the
 * person no longer exists: 404, not 500.
 */
async function personGoneAsNotFound<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const constraint = violatedConstraint(error, "23503");
    if (constraint?.startsWith("contact_policies_person_id") || constraint?.startsWith("events_person_id")) throw new NotFoundError("Person not found");
    throw error;
  }
}

export const drizzleReplyHandlingStore: ReplyHandlingStore = {
  async conversationDetail(organizationId, conversationId): Promise<ConversationDetail | null> {
    const [head] = await db
      .select({ conversation: conversations, person: people, company: companies.name })
      .from(conversations)
      .innerJoin(people, eq(people.id, conversations.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)));
    if (!head) return null;
    const { conversation, person } = head;

    const subs = await db.select().from(replyTypes).where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, conversation.replyTypeSetId)));
    const subName = (id: string | null) => subs.find((s) => s.id === id)?.name ?? null;

    const [convs, cls, draftRows, eventRows, noteRows, enrollmentRows, policy, suppressed] = await Promise.all([
      db
        .select({ id: threads.id, channel: threads.channel, accountRef: threads.accountRef, status: threads.status, updatedAt: threads.updatedAt })
        .from(threads)
        .where(and(eq(threads.conversationId, conversationId), eq(threads.organizationId, organizationId)))
        .orderBy(threads.createdAt),
      db
        .select({ c: replyTypePicks, threadId: messages.threadId })
        .from(replyTypePicks)
        .innerJoin(messages, eq(messages.id, replyTypePicks.messageId))
        .where(and(eq(replyTypePicks.conversationId, conversationId), eq(replyTypePicks.organizationId, organizationId)))
        .orderBy(desc(replyTypePicks.createdAt))
        .limit(30),
      db.select().from(drafts).where(and(eq(drafts.conversationId, conversationId), eq(drafts.organizationId, organizationId))).orderBy(desc(drafts.createdAt)).limit(30),
      db
        .select({ e: events, actorName: users.name })
        .from(events)
        .leftJoin(users, eq(users.id, events.actorUserId))
        // The person's events: this conversation's, the ones no conversation owns (a conversion, a deal), and those of other conversations.
        .where(and(eq(events.organizationId, organizationId), eq(events.personId, person.id)))
        .orderBy(desc(events.createdAt), desc(events.id))
        .limit(60),
      db
        .select({ n: notes, authorName: users.name })
        .from(notes)
        .leftJoin(users, eq(users.id, notes.createdBy))
        // Notes written on this conversation. The person's other notes live on the contact page.
        .where(and(eq(notes.organizationId, organizationId), eq(notes.conversationId, conversationId)))
        .orderBy(desc(notes.createdAt))
        .limit(100),
      db
        .select({ id: campaignEnrollments.id, campaignId: campaigns.id, campaignName: campaigns.name, channel: campaignEnrollments.channel, status: campaignEnrollments.status, stopReason: campaignEnrollments.stopReason })
        .from(campaignEnrollments)
        .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
        .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.personId, person.id)))
        .orderBy(desc(campaignEnrollments.createdAt)),
      db.select().from(contactPolicies).where(and(eq(contactPolicies.personId, person.id), eq(contactPolicies.organizationId, organizationId))),
      isSuppressed(db, organizationId, person.email),
    ]);

    const attempts = draftRows.length
      ? await db.select({ id: sendAttempts.id, draftId: sendAttempts.draftId }).from(sendAttempts).where(and(eq(sendAttempts.organizationId, organizationId), inArray(sendAttempts.draftId, draftRows.map((d) => d.id)))).orderBy(sendAttempts.createdAt)
      : [];
    const attemptOf = new Map(attempts.map((a) => [a.draftId, a.id]));
    const currentType = subs.find((s) => s.id === conversation.replyTypeId);
    // Only the latest pick of the latest reply drafts for what the thread shows: newest first, a stale pick only when the
    // reply has nothing else, as the type line picks it. Its job writes a draft only while the pick is applied at the
    // conversation's version (`loadDraftContext`, `insertDraft`), so an undone or outdated pick drafts nothing.
    const ofLatest = cls.filter(({ c }) => c.messageId === conversation.latestInboundMessageId);
    const latestPick = (ofLatest.find(({ c }) => c.status !== "stale") ?? ofLatest[0])?.c;
    const pickDrafts = latestPick && isAppliedPick(latestPick.status) && latestPick.expectedContextVersion === conversation.contextVersion;
    const [pendingJob] = pickDrafts
      ? await db
          .select({ id: aiJobs.id })
          .from(aiJobs)
          .where(and(eq(aiJobs.organizationId, organizationId), eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityType, "classification"), eq(aiJobs.entityId, latestPick.id), inArray(aiJobs.status, ["queued", "running"])))
          .limit(1)
      : [];
    const draftJobPending = pendingJob !== undefined;

    const stopOpen = await stopReviewOpen(db, conversation.latestInboundMessageId);

    const replyTypePickEntries = cls.map(({ c, threadId }): ReplyTypePickEntry => {
      const response = pickResponse(c.response);
      return {
        id: c.id,
        status: c.status,
        messageId: c.messageId,
        threadId,
        previous: { groupKey: c.previousGroupKey, name: subName(c.previousReplyTypeId) },
        proposed: { groupKey: c.proposedGroupKey, name: subName(c.proposedReplyTypeId) },
        applied: { groupKey: c.appliedGroupKey, name: subName(c.appliedReplyTypeId) },
        appliedReplyTypeId: c.appliedReplyTypeId,
        confidence: c.confidence === null ? null : Number(c.confidence),
        reasoning: c.reasoning,
        error: c.error,
        provider: c.provider,
        rules: (c.rules as TypeRules | null) ?? null,
        proposedSystemRole: subs.find((s) => s.id === c.proposedReplyTypeId)?.systemRole ?? null,
        holdReason: holdReasonOf(response.holdReason),
        stopRequested: response.stopRequested === true,
        createdAt: c.createdAt,
        ...pickFlags(c, conversation),
      };
    });

    return {
      conversation: {
        id: conversation.id,
        replyTypeSetId: conversation.replyTypeSetId,
        groupKey: conversation.groupKey,
        replyTypeId: conversation.replyTypeId,
        replyTypeName: subName(conversation.replyTypeId),
        replyTypeSource: conversation.replyTypeSource,
        replyTypeLocked: conversation.replyTypeLocked,
        replyTypeRules: currentType ? typeRulesOf(currentType) : null,
        replyTypeSystemRole: currentType?.systemRole ?? null,
        draftJobPending,
        workflowState: conversation.workflowState,
        activeChannel: conversation.activeChannel,
        contextVersion: conversation.contextVersion,
        latestInboundMessageId: conversation.latestInboundMessageId,
        stopReviewOpen: stopOpen,
        lastInboundAt: conversation.lastInboundAt,
        lastOutboundAt: conversation.lastOutboundAt,
        nextActionAt: conversation.nextActionAt,
        closedReason: conversation.closedReason,
        assignedTo: conversation.assignedTo,
        createdAt: conversation.createdAt,
      },
      person: {
        id: person.id,
        name: personName(person),
        email: person.email,
        linkedinUrl: person.linkedinSlug ? `https://www.linkedin.com/in/${person.linkedinSlug}` : null,
        phone: person.phone,
        title: person.title,
        company: head.company,
      },
      policy: policy[0] ? { doNotContact: policy[0].doNotContact, reason: policy[0].reason, source: policy[0].source, setAt: policy[0].setAt, clearedAt: policy[0].clearedAt } : null,
      suppressed,
      threads: convs,
      replyTypePicks: replyTypePickEntries,
      drafts: draftRows.map(
        (d): DraftEntry => ({
          id: d.id,
          threadId: d.threadId,
          channel: d.channel,
          status: d.status,
          subject: d.subject,
          preview: (d.editedBodyText ?? d.aiBodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          revision: d.revision,
          expectedContextVersion: d.expectedContextVersion,
          createdAt: d.createdAt,
          attemptId: attemptOf.get(d.id) ?? null,
        }),
      ),
      events: eventRows.map(({ e, actorName }): EventEntry => ({ id: e.id, eventType: e.eventType, actorType: e.actorType, actorName, createdAt: e.createdAt, fromData: e.fromData, toData: e.toData, meta: e.meta })),
      notes: noteRows.map(({ n, authorName }): NoteEntry => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, authorName, createdBy: n.createdBy })),
      enrollments: enrollmentRows,
      replyTypes: subs.sort(byGroupThenOrder).map(replyTypeOption),
    };
  },

  async draftIdForAttempt(organizationId, attemptId) {
    const [row] = await db.select({ draftId: sendAttempts.draftId }).from(sendAttempts).where(and(eq(sendAttempts.id, attemptId), eq(sendAttempts.organizationId, organizationId)));
    return row?.draftId ?? null;
  },

  async typeChangeFacts(organizationId, conversationId) {
    return typeChangeFactsOf(organizationId, conversationId);
  },

  async changeReplyType(input) {
    return db.transaction(async (tx) => {
      const before = await lockConversation(tx, input.organizationId, input.conversationId);
      let sub: typeof replyTypes.$inferSelect | undefined;
      if (input.replyTypeId) {
        [sub] = await tx
          .select()
          .from(replyTypes)
          .where(and(eq(replyTypes.id, input.replyTypeId), eq(replyTypes.organizationId, input.organizationId), eq(replyTypes.replyTypeSetId, before.replyTypeSetId)));
        if (!sub) throw new NotFoundError("Reply type not found");
        if (sub.groupKey !== input.groupKey) throw new ValidationError("That reply type belongs to another group.");
      }
      const { replyTypeLocked } = checkReplyTypeChange({
        before: { groupKey: before.groupKey, replyTypeId: before.replyTypeId, replyTypeLocked: before.replyTypeLocked, contextVersion: before.contextVersion, workflowState: before.workflowState },
        target: { groupKey: input.groupKey, replyTypeId: input.replyTypeId, systemRole: sub?.systemRole ?? null },
        expectedContextVersion: input.expectedContextVersion,
        confirmUnlock: input.confirmUnlock,
      });
      // The type's rules decide, as a person's pick: a type that writes a draft keeps the conversation in front of a person,
      // and its follow-ups rule decides whether a run starts. A change to a group without a type has no rules: no run.
      const rules = sub ? typeRulesOf(sub) : null;
      const decision = sub && rules ? await personTypeDecisionTx(tx, { organizationId: input.organizationId, conversation: before, target: { groupKey: sub.groupKey, systemRole: sub.systemRole, rules } }) : null;
      await tx
        .update(conversations)
        .set({
          groupKey: input.groupKey,
          replyTypeId: input.replyTypeId,
          replyTypeSource: "human",
          replyTypeLocked,
          workflowState: afterTypeChange(before.workflowState as WorkflowState, { wantsDraft: decision?.wantsDraft ?? false }),
          nextActionAt: null,
        })
        .where(eq(conversations.id, before.id));
      // The old type's run and drafts end, the version goes up, and the new type's sequence starts, all in this commit.
      const { contextVersion: version, draftsRetired, runsEnded, runStarted } = await restartConversationWorkTx(tx, {
        organizationId: input.organizationId,
        conversationId: before.id,
        reason: "type_changed",
        draftReason: "A person changed the reply type after this draft was written.",
        followUps: decision?.followUps ?? "not_applicable",
        now: input.now,
        actorUserId: input.actorUserId,
      });
      await personReviewedStopsTx(tx, { organizationId: input.organizationId, conversationId: before.id, actorUserId: input.actorUserId, via: input.via, now: input.now });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: before.personId,
        conversationId: before.id,
        eventType: "reply_type.changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: before.groupKey, replyTypeId: before.replyTypeId, replyTypeSource: before.replyTypeSource, replyTypeLocked: before.replyTypeLocked },
        toData: { groupKey: input.groupKey, replyTypeId: input.replyTypeId, replyTypeSource: "human", replyTypeLocked },
        meta: { note: input.note, occurredAt: input.occurredAt.toISOString(), unlockedCustomer: before.replyTypeLocked && !replyTypeLocked, rules, ...viaMeta(input.via) },
        contextVersion: version,
      });
      return { conversationId: before.id, personId: before.personId, groupKey: input.groupKey, replyTypeKey: sub?.key ?? null, contextVersion: version, draftsRetired, runStarted, runEnded: runsEnded > 0 };
    });
  },

  async undoReplyTypePick(input) {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ conversationId: replyTypePicks.conversationId })
        .from(replyTypePicks)
        .where(and(eq(replyTypePicks.id, input.replyTypePickId), eq(replyTypePicks.organizationId, input.organizationId)));
      if (!candidate) throw new NotFoundError("AI pick not found");
      const conversation = await lockConversation(tx, input.organizationId, candidate.conversationId);
      const [cls] = await tx.select().from(replyTypePicks).where(eq(replyTypePicks.id, input.replyTypePickId)).for("update");
      if (cls.messageId !== conversation.latestInboundMessageId) throw new ConflictError("Only the pick of the latest inbound message can be undone.");
      if (!cls.appliedGroupKey || !isAppliedPick(cls.status)) throw new ConflictError("This AI pick has no applied change to undo.");
      if (conversation.groupKey !== cls.appliedGroupKey || conversation.replyTypeId !== cls.appliedReplyTypeId) {
        throw new ConflictError("A person changed the reply type after this pick. Change the type by hand.");
      }
      const previous = cls.previousGroupKey;
      const previousTypeId = previous ? cls.previousReplyTypeId : null;
      // The lock comes back as the conversation had it before the pick.
      const previousLocked = previous !== null && lockBeforePick(cls.response, previous);
      await tx.update(replyTypePicks).set({ status: "rejected" }).where(and(eq(replyTypePicks.id, cls.id), pickMayBecome("rejected")));
      await personReviewedStopsTx(tx, { organizationId: input.organizationId, conversationId: conversation.id, messageId: cls.messageId, actorUserId: input.actorUserId, via: input.via, now: input.now });
      // A draft job that has not run yet would write a reply for the classification a person just rejected. A job that
      // already runs read the old version, and `insertDraft` writes its draft as stale once this commit bumps it.
      const cancelled = await tx
        .update(aiJobs)
        .set({ status: "failed", failedAt: input.now, lastError: "The classification was undone before the draft was written." })
        .where(and(eq(aiJobs.organizationId, input.organizationId), eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityId, cls.id), eq(aiJobs.status, "queued")))
        .returning({ id: aiJobs.id });
      // A rerun a person's pick asked for has nothing left to draft for.
      const running = await tx
        .update(aiJobs)
        .set({ payload: sql`${aiJobs.payload} - 'rerun'` })
        .where(and(eq(aiJobs.organizationId, input.organizationId), eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityId, cls.id), eq(aiJobs.status, "running")))
        .returning({ id: aiJobs.id });
      // The run started for the classification a person just rejected. It ends in this commit and keeps no follow-up drafting.
      const { contextVersion: version, draftsRetired, runsEnded } = await advanceConversationContextTx(tx, {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        now: input.now,
        set: {
          groupKey: previous,
          replyTypeId: previousTypeId,
          replyTypeSource: previous ? "human" : null,
          replyTypeLocked: previousLocked,
          workflowState: afterPersonDecision(conversation.workflowState),
          nextActionAt: null,
        },
        drafts: { reason: "The classification was undone after this draft was written." },
        runs: "pick_undone",
      });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: conversation.personId,
        conversationId: conversation.id,
        eventType: "reply_type_pick.undone",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: conversation.groupKey, replyTypeId: conversation.replyTypeId },
        toData: { groupKey: previous, replyTypeId: previous ? cls.previousReplyTypeId : null },
        meta: { replyTypePickId: cls.id, draftsRetired, runsEnded, ...viaMeta(input.via) },
        contextVersion: version,
      });
      return { conversationId: conversation.id, draftsRetired, runEnded: runsEnded > 0, draftJobCancelled: cancelled.length + running.length > 0 };
    });
  },

  async setDoNotContact(input): Promise<DncResult> {
    return personGoneAsNotFound(() => db.transaction(async (tx) => {
      const [person] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, input.personId), eq(people.organizationId, input.organizationId)));
      if (!person) throw new NotFoundError("Person not found");
      // People writes the policy under the person's `dnc:` lock; the follow-through on conversations, drafts, runs and enrollments is ours.
      const { changed, previous } = await writeDoNotContactTx(tx, input);
      if (!changed) return { changed: false, doNotContact: input.enabled, recordsUpdated: 0, draftsRetired: 0, enrollmentsStopped: 0 };

      if (!input.enabled) {
        await tx.insert(events).values({
          organizationId: input.organizationId,
          personId: input.personId,
          eventType: "contact_policy.dnc_cleared",
          actorType: "human",
          actorUserId: input.actorUserId,
          fromData: { doNotContact: true, reason: previous?.reason ?? null },
          toData: { doNotContact: false },
          meta: { reason: input.reason },
        });
        return { changed: true, doNotContact: false, recordsUpdated: 0, draftsRetired: 0, enrollmentsStopped: 0 };
      }


      const owned = await tx.select().from(conversations).where(and(eq(conversations.personId, input.personId), eq(conversations.organizationId, input.organizationId))).for("no key update");
      const conversationIds = owned.map((r) => r.id);
      let draftsRetired = 0;
      for (const conversation of owned) {
        const advanced = await advanceConversationContextTx(tx, {
          organizationId: input.organizationId,
          conversationId: conversation.id,
          now: input.now,
          set: { workflowState: afterPersonDecision(conversation.workflowState), nextActionAt: null },
          drafts: { reason: "The person was marked do not contact." },
        });
        await personReviewedStopsTx(tx, { organizationId: input.organizationId, conversationId: conversation.id, actorUserId: input.actorUserId, now: input.now });
        draftsRetired += advanced.draftsRetired;
        await tx.insert(events).values({
          organizationId: input.organizationId,
          personId: input.personId,
          conversationId: conversation.id,
          eventType: "contact_policy.enforced",
          actorType: "human",
          actorUserId: input.actorUserId,
          fromData: { workflowState: conversation.workflowState },
          meta: { policy: "do_not_contact", reason: input.reason },
          contextVersion: advanced.contextVersion,
        });
      }
      await interruptPersonRunsTx(tx, input.organizationId, [input.personId], "do_not_contact", input.now);
      const stopped = await haltPersonEnrollmentsTx(tx, input.organizationId, [input.personId], "do_not_contact", input.now);
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: input.personId,
        eventType: "contact_policy.dnc_set",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: previous ? { doNotContact: previous.doNotContact, reason: previous.reason } : null,
        toData: { doNotContact: true, reason: input.reason },
        meta: { enrollmentsStopped: stopped.length, draftsRetired, conversations: conversationIds.length },
      });
      return { changed: true, doNotContact: true, recordsUpdated: conversationIds.length, draftsRetired, enrollmentsStopped: stopped.length };
    }));
  },

  async closeConversation(input) {
    await db.transaction(async (tx) => {
      const conversation = await lockConversation(tx, input.organizationId, input.conversationId);
      if (conversation.workflowState === "closed") throw new ConflictError("Reply handling is already closed.");
      // A reply send holds its conversation FOR UPDATE from before it reads the workflow state to its commit. The share lock
      // waits for one in progress, so the close lands after it, and a send that starts later reads the close
      // (docs/decisions.md, "Reply send rules").
      await tx.select({ id: threads.id }).from(threads).where(eq(threads.conversationId, conversation.id)).for("share");
      const { contextVersion: version } = await advanceConversationContextTx(tx, {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        now: input.now,
        set: { workflowState: "closed", closedReason: input.reason, nextActionAt: null },
        drafts: { reason: MARKED_DONE },
        runs: "conversation_closed",
      });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: conversation.personId,
        conversationId: conversation.id,
        eventType: "workflow.state_changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { workflowState: conversation.workflowState },
        toData: { workflowState: "closed" },
        meta: { reason: input.reason, ...viaMeta(input.via) },
        contextVersion: version,
      });
    });
  },

  async reopenConversation(input) {
    await db.transaction(async (tx) => {
      const conversation = await lockConversation(tx, input.organizationId, input.conversationId);
      if (conversation.workflowState !== "closed") throw new ConflictError("Reply handling is already open.");
      const next = afterReopen(conversation.latestInboundMessageId !== null);
      const { contextVersion: version } = await advanceConversationContextTx(tx, {
        organizationId: input.organizationId,
        conversationId: conversation.id,
        now: input.now,
        set: { workflowState: next, closedReason: null },
      });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: conversation.personId,
        conversationId: conversation.id,
        eventType: "workflow.state_changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { workflowState: "closed" },
        toData: { workflowState: next },
        meta: { reason: "reopened", ...viaMeta(input.via) },
        contextVersion: version,
      });
    });
  },

  async addNote(input) {
    const { scope } = input;
    let owner: { personId: string; conversationId: string | null };
    if (scope.conversationId !== undefined) {
      const [conversation] = await db.select({ id: conversations.id, personId: conversations.personId }).from(conversations).where(and(eq(conversations.id, scope.conversationId), eq(conversations.organizationId, input.organizationId)));
      if (!conversation) throw new NotFoundError("Reply handling not found");
      owner = { personId: conversation.personId, conversationId: conversation.id };
    } else {
      // A note by person works without a reply conversation, so it is stored with a null conversation_id.
      const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, scope.personId), eq(people.organizationId, input.organizationId)));
      if (!person) throw new NotFoundError("Person not found");
      owner = { personId: person.id, conversationId: null };
    }
    const [row] = await db
      .insert(notes)
      .values({ organizationId: input.organizationId, ...owner, title: input.title, body: input.body, createdBy: input.actorUserId })
      .returning({ id: notes.id });
    return row;
  },

  async deleteNote(input) {
    const { scope } = input;
    const removed = await db
      .delete(notes)
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.organizationId, input.organizationId),
          scope.conversationId !== undefined ? eq(notes.conversationId, scope.conversationId) : eq(notes.personId, scope.personId),
        ),
      )
      .returning({ id: notes.id });
    return removed.length > 0;
  },

  async replyTypeCatalog(organizationId): Promise<ReplyTypeCatalog> {
    const replyTypeSetId = await replyTypeSetFor(organizationId);
    const [replyTypeSet] = rowsOf<{ id: string; name: string }>(await db.execute(sql`select id, name from reply_type_sets where id = ${replyTypeSetId}`));
    const rows = await db
      .select()
      .from(replyTypes)
      .where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, replyTypeSetId)));
    return {
      replyTypeSet,
      replyTypes: rows
        .map((r) => ({
          id: r.id,
          groupKey: r.groupKey as ReplyTypeGroup,
          key: r.key,
          name: r.name,
          description: r.description,
          classificationGuidance: r.classificationGuidance,
          rules: typeRulesOf(r),
          systemRole: r.systemRole ?? null,
          sortOrder: r.sortOrder,
        }))
        .sort(byGroupThenOrder),
      settings: await settingsOf(replyTypeSetId),
    };
  },

  async replySettings(organizationId) {
    return settingsOf(await replyTypeSetFor(organizationId));
  },

  async updateSettings(organizationId, patch) {
    const replyTypeSetId = await replyTypeSetFor(organizationId);
    await db
      .update(replyHandlingSettings)
      .set(patch)
      .where(and(eq(replyHandlingSettings.replyTypeSetId, replyTypeSetId), eq(replyHandlingSettings.organizationId, organizationId)));
  },

  async listIdentityExceptions(organizationId, status) {
    const rows = await db
      .select()
      .from(identityExceptions)
      .where(and(eq(identityExceptions.organizationId, organizationId), eq(identityExceptions.status, status)))
      .orderBy(desc(identityExceptions.createdAt))
      .limit(200);
    return rows;
  },

  async getIdentityException(organizationId, id) {
    const [row] = await db.select().from(identityExceptions).where(and(eq(identityExceptions.id, id), eq(identityExceptions.organizationId, organizationId)));
    return row ?? null;
  },

  async insertIdentityException(input) {
    const [created] = await db
      .insert(identityExceptions)
      .values({
        organizationId: input.organizationId,
        channel: input.channel,
        accountRef: input.accountRef,
        sourceEventKey: input.sourceEventKey,
        identityValue: input.identityValue,
        reason: input.reason,
        payload: input.payload,
      })
      .onConflictDoNothing()
      .returning({ id: identityExceptions.id });
    if (created) return { id: created.id, created: true };
    // The unique key spans organizations; only this organization's row may be returned.
    const [existing] = await db
      .select({ id: identityExceptions.id })
      .from(identityExceptions)
      .where(and(eq(identityExceptions.organizationId, input.organizationId), eq(identityExceptions.channel, input.channel), eq(identityExceptions.accountRef, input.accountRef), eq(identityExceptions.sourceEventKey, input.sourceEventKey)));
    if (!existing) throw new ConflictError("This provider event was already recorded.");
    return { id: existing.id, created: false };
  },

  async closeIdentityException({ organizationId, id, outcome, now }) {
    const closed = await db
      .update(identityExceptions)
      .set(outcome.status === "resolved" ? { status: "resolved", resolvedPersonId: outcome.personId, resolvedAt: now } : { status: "ignored", resolvedPersonId: null, resolvedAt: now })
      .where(and(eq(identityExceptions.id, id), eq(identityExceptions.organizationId, organizationId), eq(identityExceptions.status, "open")))
      .returning({ id: identityExceptions.id });
    return closed.length > 0;
  },

  async personForReplay(organizationId, personId) {
    const [row] = await db.select({ id: people.id, email: people.email }).from(people).where(and(eq(people.id, personId), eq(people.organizationId, organizationId)));
    return row ?? null;
  },
};
