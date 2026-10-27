import { violatedConstraint } from "@/platform/db/errors";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { interruptPersonRunsTx, interruptRecordRunsTx } from "../after-reply/infrastructure/sequence-stop";
import { personTypeDecisionTx, restartRecordWorkTx } from "./restart-record-work";
import {
  aiJobs,
  campaignEnrollments,
  campaigns,
  replyTypePicks,
  companies,
  contactPolicies,
  conversations,
  drafts,
  events,
  identityExceptions,
  messages,
  notes,
  people,
  replyHandlingSettings,
  records,
  sendAttempts,
  replyTypes,
  suppressionList,
  users,
} from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type {
  ReplyTypePickEntry,
  ReplyHandlingStore,
  DncResult,
  DraftEntry,
  EventEntry,
  NoteEntry,
  RecordDetail,
  ReplyHandlingSettingsRow,
  ReplyTypeCatalog,
  ReplyTypeOption,
} from "../application/reply-handling-ports";
import { byGroupThenOrder, checkReplyTypeChange, lockBeforePick, type ReplyTypeGroup } from "../domain/reply-handling";
import { afterPersonDecision, afterReopen, afterTypeChange, type WorkflowState } from "../domain/workflow-state";
import { holdReasonOf, typeRulesOf, type TypeRules } from "../domain/reply-type";
import { replyTypeOption, typeChangeFactsOf } from "./type-change-facts-read";
import { defaultReplyTypeSetId, type Tx } from "./drizzle-conversation-store";
import { onVisibleRecordSql, publicConversation, visibleReplyTypePickSql, visibleDraftSql, visibleRecordSql } from "@/platform/db/conversation-visibility";
import { draftCanBecome } from "./reply-store-shared";
import { LIVE_ENROLLMENT_STATUSES } from "@/contexts/outreach/domain/enrollment-status";
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

/** The confidence floor and the AI instructions of a set. `replyTypeSetFor` makes sure the row exists. */
async function settingsOf(replyTypeSetId: string): Promise<ReplyHandlingSettingsRow> {
  const [settings] = await db.select().from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, replyTypeSetId));
  return {
    autoApplyConfidence: Number(settings.autoApplyConfidence),
    draftInstructions: settings.draftInstructions,
    classificationInstructions: settings.classificationInstructions,
  };
}

/** Locks a record a person may see. A record whose conversations are all private answers 404, as a foreign id does. */
async function lockRecord(tx: Tx, organizationId: string, recordId: string) {
  const [row] = await tx
    .select()
    .from(records)
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId), visibleRecordSql("records")))
    .for("update");
  if (!row) throw new NotFoundError("Reply handling not found");
  return row;
}

/** Drafts written for the old context can no longer be sent; mark them so they leave the review queues. */
async function retireOpenDrafts(tx: Tx, recordIds: string[], reason: string) {
  if (recordIds.length === 0) return 0;
  const retired = await tx
    .update(drafts)
    .set({ status: "stale", error: reason })
    .where(and(inArray(drafts.recordId, recordIds), draftCanBecome("stale")))
    .returning({ id: drafts.id });
  return retired.length;
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
  async recordDetail(organizationId, recordId): Promise<RecordDetail | null> {
    const [head] = await db
      .select({ record: records, person: people, company: companies.name })
      .from(records)
      .innerJoin(people, eq(people.id, records.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId), visibleRecordSql("records")));
    if (!head) return null;
    const { record, person } = head;

    const subs = await db.select().from(replyTypes).where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, record.replyTypeSetId)));
    const subName = (id: string | null) => subs.find((s) => s.id === id)?.name ?? null;

    const [convs, cls, draftRows, eventRows, noteRows, enrollmentRows, policy, suppressed] = await Promise.all([
      db
        .select({ id: conversations.id, channel: conversations.channel, accountRef: conversations.accountRef, status: conversations.status })
        .from(conversations)
        .where(and(eq(conversations.recordId, recordId), eq(conversations.organizationId, organizationId), publicConversation))
        .orderBy(conversations.createdAt),
      db
        .select({ c: replyTypePicks, conversationId: messages.conversationId })
        .from(replyTypePicks)
        .innerJoin(messages, eq(messages.id, replyTypePicks.messageId))
        .where(and(eq(replyTypePicks.recordId, recordId), eq(replyTypePicks.organizationId, organizationId), visibleReplyTypePickSql("reply_type_picks")))
        .orderBy(desc(replyTypePicks.createdAt))
        .limit(30),
      db.select().from(drafts).where(and(eq(drafts.recordId, recordId), eq(drafts.organizationId, organizationId), visibleDraftSql("drafts"))).orderBy(desc(drafts.createdAt)).limit(30),
      db
        .select({ e: events, actorName: users.name })
        .from(events)
        .leftJoin(users, eq(users.id, events.actorUserId))
        // The person's events: this record's, the ones no record owns (a conversion, a deal), and those of other records
        // with a public thread. Events of a record that exists only for a private thread stay out.
        .where(
          and(
            eq(events.organizationId, organizationId),
            eq(events.personId, person.id),
            sql`(${events.recordId} is null or ${events.recordId} = ${recordId} or exists (select 1 from records er where er.id = ${events.recordId} and ${visibleRecordSql("er")}))`,
          ),
        )
        .orderBy(desc(events.createdAt), desc(events.id))
        .limit(60),
      db
        .select({ n: notes, authorName: users.name })
        .from(notes)
        .leftJoin(users, eq(users.id, notes.createdBy))
        // Notes written on this record. The person's other notes live on the contact page.
        .where(and(eq(notes.organizationId, organizationId), eq(notes.recordId, recordId)))
        .orderBy(desc(notes.createdAt))
        .limit(100),
      db
        .select({ id: campaignEnrollments.id, campaignId: campaigns.id, campaignName: campaigns.name, channel: campaignEnrollments.channel, status: campaignEnrollments.status, stopReason: campaignEnrollments.stopReason })
        .from(campaignEnrollments)
        .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
        // Enrollments in a personal campaign stay out of the shared record.
        .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.personId, person.id), eq(campaigns.type, "regular")))
        .orderBy(desc(campaignEnrollments.createdAt)),
      db.select().from(contactPolicies).where(and(eq(contactPolicies.personId, person.id), eq(contactPolicies.organizationId, organizationId))),
      person.email
        ? db.select({ id: suppressionList.id }).from(suppressionList).where(and(eq(suppressionList.organizationId, organizationId), eq(suppressionList.email, person.email.toLowerCase())))
        : Promise.resolve([]),
    ]);

    const attempts = draftRows.length
      ? await db.select({ id: sendAttempts.id, draftId: sendAttempts.draftId }).from(sendAttempts).where(and(eq(sendAttempts.organizationId, organizationId), inArray(sendAttempts.draftId, draftRows.map((d) => d.id)))).orderBy(sendAttempts.createdAt)
      : [];
    const attemptOf = new Map(attempts.map((a) => [a.draftId, a.id]));
    const currentType = subs.find((s) => s.id === record.replyTypeId);
    // Only the latest pick of the latest reply drafts for what the thread shows: newest first, a stale pick only when the
    // reply has nothing else, as the type line picks it. Its job writes a draft only while the pick is applied at the
    // record's version (`loadDraftContext`, `insertDraft`), so an undone or outdated pick drafts nothing.
    const ofLatest = cls.filter(({ c }) => c.messageId === record.latestInboundMessageId);
    const latestPick = (ofLatest.find(({ c }) => c.status !== "stale") ?? ofLatest[0])?.c;
    const pickDrafts = latestPick && ["auto_applied", "accepted", "overridden"].includes(latestPick.status) && latestPick.expectedContextVersion === record.contextVersion;
    const [pendingJob] = pickDrafts
      ? await db
          .select({ id: aiJobs.id })
          .from(aiJobs)
          .where(and(eq(aiJobs.organizationId, organizationId), eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityType, "classification"), eq(aiJobs.entityId, latestPick.id), inArray(aiJobs.status, ["queued", "running"])))
          .limit(1)
      : [];
    const draftJobPending = pendingJob !== undefined;

    const replyTypePickEntries = cls.map(({ c, conversationId }): ReplyTypePickEntry => {
      const latest = c.messageId === record.latestInboundMessageId;
      const applied = ["auto_applied", "accepted", "overridden"].includes(c.status) && c.appliedGroupKey !== null;
      const response = (c.response ?? {}) as { holdReason?: unknown; stopRequested?: boolean };
      return {
        id: c.id,
        status: c.status,
        messageId: c.messageId,
        conversationId,
        previous: { groupKey: c.previousGroupKey, name: subName(c.previousReplyTypeId) },
        proposed: { groupKey: c.proposedGroupKey, name: subName(c.proposedReplyTypeId) },
        applied: { groupKey: c.appliedGroupKey, name: subName(c.appliedReplyTypeId) },
        appliedReplyTypeId: c.appliedReplyTypeId,
        confidence: c.confidence === null ? null : Number(c.confidence),
        reasoning: c.reasoning,
        error: c.error,
        provider: c.provider,
        acknowledged: c.acknowledgedAt !== null,
        rules: (c.rules as TypeRules | null) ?? null,
        proposedSystemRole: subs.find((s) => s.id === c.proposedReplyTypeId)?.systemRole ?? null,
        holdReason: holdReasonOf(response.holdReason),
        stopRequested: response.stopRequested === true,
        createdAt: c.createdAt,
        latest,
        current: c.expectedContextVersion === record.contextVersion && c.status !== "stale",
        canUndo: latest && applied,
        canAcknowledge: c.acknowledgedAt === null && (c.status === "auto_applied" || c.status === "failed"),
      };
    });

    return {
      record: {
        id: record.id,
        replyTypeSetId: record.replyTypeSetId,
        groupKey: record.groupKey,
        replyTypeId: record.replyTypeId,
        replyTypeName: subName(record.replyTypeId),
        replyTypeSource: record.replyTypeSource,
        replyTypeLocked: record.replyTypeLocked,
        replyTypeRules: currentType ? typeRulesOf(currentType) : null,
        replyTypeSystemRole: currentType?.systemRole ?? null,
        draftJobPending,
        workflowState: record.workflowState,
        activeChannel: record.activeChannel,
        contextVersion: record.contextVersion,
        latestInboundMessageId: record.latestInboundMessageId,
        lastInboundAt: record.lastInboundAt,
        lastOutboundAt: record.lastOutboundAt,
        nextActionAt: record.nextActionAt,
        closedReason: record.closedReason,
        assignedTo: record.assignedTo,
        createdAt: record.createdAt,
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
      suppressed: suppressed.length > 0,
      conversations: convs,
      replyTypePicks: replyTypePickEntries,
      drafts: draftRows.map(
        (d): DraftEntry => ({
          id: d.id,
          conversationId: d.conversationId,
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
      replyTypes: subs
        .filter((s) => s.active)
        .sort(byGroupThenOrder)
        .map(replyTypeOption),
    };
  },

  async draftIdForAttempt(organizationId, attemptId) {
    const [row] = await db.select({ draftId: sendAttempts.draftId }).from(sendAttempts).where(and(eq(sendAttempts.id, attemptId), eq(sendAttempts.organizationId, organizationId)));
    return row?.draftId ?? null;
  },

  async typeChangeFacts(organizationId, recordId) {
    return typeChangeFactsOf(organizationId, recordId);
  },

  async changeReplyType(input) {
    return db.transaction(async (tx) => {
      const before = await lockRecord(tx, input.organizationId, input.recordId);
      let sub: typeof replyTypes.$inferSelect | undefined;
      if (input.replyTypeId) {
        [sub] = await tx
          .select()
          .from(replyTypes)
          .where(and(eq(replyTypes.id, input.replyTypeId), eq(replyTypes.organizationId, input.organizationId), eq(replyTypes.replyTypeSetId, before.replyTypeSetId)));
        if (!sub) throw new NotFoundError("Reply type not found");
        if (sub.groupKey !== input.groupKey) throw new ValidationError("That reply type belongs to another group.");
        if (!sub.active) throw new ConflictError("An archived reply type cannot be assigned.");
      }
      const { replyTypeLocked } = checkReplyTypeChange({
        before: { groupKey: before.groupKey, replyTypeId: before.replyTypeId, replyTypeLocked: before.replyTypeLocked, contextVersion: before.contextVersion, workflowState: before.workflowState },
        target: { groupKey: input.groupKey, replyTypeId: input.replyTypeId, systemRole: sub?.systemRole ?? null },
        expectedContextVersion: input.expectedContextVersion,
        confirmUnlock: input.confirmUnlock,
      });
      // The type's rules decide, as a person's pick: a type that writes a draft keeps the record in front of a person,
      // and its follow-ups rule decides whether a run starts. A change to a group without a type has no rules: no run.
      const rules = sub ? typeRulesOf(sub) : null;
      const decision = sub && rules ? await personTypeDecisionTx(tx, { organizationId: input.organizationId, record: before, target: { groupKey: sub.groupKey, rules } }) : null;
      await tx
        .update(records)
        .set({
          groupKey: input.groupKey,
          replyTypeId: input.replyTypeId,
          replyTypeSource: "human",
          replyTypeLocked,
          workflowState: afterTypeChange(before.workflowState as WorkflowState, { wantsDraft: decision?.wantsDraft ?? false }),
          nextActionAt: null,
        })
        .where(eq(records.id, before.id));
      // The old type's run and drafts end, the version goes up, and the new type's sequence starts, all in this commit.
      const { contextVersion: version, draftsRetired, runStarted } = await restartRecordWorkTx(tx, {
        organizationId: input.organizationId,
        recordId: before.id,
        reason: "stage_moved",
        draftReason: "A person changed the reply type after this draft was written.",
        followUps: decision?.followUps ?? "not_applicable",
        now: input.now,
        actorUserId: input.actorUserId,
      });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: before.personId,
        recordId: before.id,
        eventType: "reply_type.changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: before.groupKey, replyTypeId: before.replyTypeId, replyTypeSource: before.replyTypeSource, replyTypeLocked: before.replyTypeLocked },
        toData: { groupKey: input.groupKey, replyTypeId: input.replyTypeId, replyTypeSource: "human", replyTypeLocked },
        meta: { note: input.note, occurredAt: input.occurredAt.toISOString(), unlockedCustomer: before.replyTypeLocked && !replyTypeLocked, rules },
        contextVersion: version,
      });
      return { recordId: before.id, personId: before.personId, groupKey: input.groupKey, replyTypeKey: sub?.key ?? null, contextVersion: version, draftsRetired, runStarted };
    });
  },

  async undoReplyTypePick(input) {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ recordId: replyTypePicks.recordId })
        .from(replyTypePicks)
        .where(and(eq(replyTypePicks.id, input.replyTypePickId), eq(replyTypePicks.organizationId, input.organizationId), visibleReplyTypePickSql("reply_type_picks")));
      if (!candidate) throw new NotFoundError("AI pick not found");
      const record = await lockRecord(tx, input.organizationId, candidate.recordId);
      const [cls] = await tx.select().from(replyTypePicks).where(eq(replyTypePicks.id, input.replyTypePickId)).for("update");
      if (cls.messageId !== record.latestInboundMessageId) throw new ConflictError("Only the pick of the latest inbound message can be undone.");
      if (!cls.appliedGroupKey || !["auto_applied", "accepted", "overridden"].includes(cls.status)) throw new ConflictError("This AI pick has no applied change to undo.");
      if (record.groupKey !== cls.appliedGroupKey || record.replyTypeId !== cls.appliedReplyTypeId) {
        throw new ConflictError("A person changed the reply type after this pick. Change the type by hand.");
      }
      const version = record.contextVersion + 1;
      const previous = cls.previousGroupKey;
      const previousTypeId = previous ? cls.previousReplyTypeId : null;
      // The lock comes back as the record had it before the pick.
      const previousLocked = previous !== null && lockBeforePick(cls.response, previous);
      await tx
        .update(records)
        .set({
          groupKey: previous,
          replyTypeId: previousTypeId,
          replyTypeSource: previous ? "human" : null,
          replyTypeLocked: previousLocked,
          workflowState: afterPersonDecision(record.workflowState),
          nextActionAt: null,
          contextVersion: version,
        })
        .where(eq(records.id, record.id));
      await tx.update(replyTypePicks).set({ status: "rejected", acknowledgedAt: input.now }).where(eq(replyTypePicks.id, cls.id));
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
      const draftsRetired = await retireOpenDrafts(tx, [record.id], "The classification was undone after this draft was written.");
      // The run started for the classification a person just rejected. It ends in this commit and keeps no follow-up drafting.
      const runsEnded = await interruptRecordRunsTx(tx, input.organizationId, record.id, "classification_undone", input.now);
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "reply_type_pick.undone",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { groupKey: record.groupKey, replyTypeId: record.replyTypeId },
        toData: { groupKey: previous, replyTypeId: previous ? cls.previousReplyTypeId : null },
        meta: { replyTypePickId: cls.id, draftsRetired, runsEnded },
        contextVersion: version,
      });
      return { recordId: record.id, draftsRetired, runEnded: runsEnded > 0, draftJobCancelled: cancelled.length + running.length > 0 };
    });
  },

  async acknowledgeReplyTypePick(input) {
    await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ recordId: replyTypePicks.recordId })
        .from(replyTypePicks)
        .where(and(eq(replyTypePicks.id, input.replyTypePickId), eq(replyTypePicks.organizationId, input.organizationId), visibleReplyTypePickSql("reply_type_picks")));
      if (!candidate) throw new NotFoundError("AI pick not found");
      const record = await lockRecord(tx, input.organizationId, candidate.recordId);
      const [cls] = await tx.select().from(replyTypePicks).where(eq(replyTypePicks.id, input.replyTypePickId)).for("update");
      if (cls.acknowledgedAt) return;
      if (cls.status === "proposed") throw new ConflictError("Accept or change the AI's suggestion instead of acknowledging it.");
      await tx.update(replyTypePicks).set({ acknowledgedAt: input.now }).where(eq(replyTypePicks.id, cls.id));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "reply_type_pick.acknowledged",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { replyTypePickId: cls.id },
        contextVersion: record.contextVersion,
      });
    });
  },

  async setDoNotContact(input): Promise<DncResult> {
    return personGoneAsNotFound(() => db.transaction(async (tx) => {
      const [person] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, input.personId), eq(people.organizationId, input.organizationId)));
      if (!person) throw new NotFoundError("Person not found");
      // One writer per person at a time, across set and clear.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dnc:${input.personId}`}, 0))`);
      const [previous] = await tx.select().from(contactPolicies).where(eq(contactPolicies.personId, input.personId));

      if (!input.enabled) {
        if (!previous?.doNotContact) return { changed: false, doNotContact: false, recordsUpdated: 0, draftsRetired: 0, enrollmentsStopped: 0 };
        await tx
          .update(contactPolicies)
          .set({ doNotContact: false, clearedAt: input.now, reason: input.reason, updatedAt: input.now })
          .where(eq(contactPolicies.personId, input.personId));
        await tx.insert(events).values({
          organizationId: input.organizationId,
          personId: input.personId,
          eventType: "contact_policy.dnc_cleared",
          actorType: "human",
          actorUserId: input.actorUserId,
          fromData: { doNotContact: true, reason: previous.reason },
          toData: { doNotContact: false },
          meta: { reason: input.reason },
        });
        return { changed: true, doNotContact: false, recordsUpdated: 0, draftsRetired: 0, enrollmentsStopped: 0 };
      }

      if (previous?.doNotContact) return { changed: false, doNotContact: true, recordsUpdated: 0, draftsRetired: 0, enrollmentsStopped: 0 };
      await tx
        .insert(contactPolicies)
        .values({ personId: input.personId, organizationId: input.organizationId, doNotContact: true, reason: input.reason, source: "human", setAt: input.now, clearedAt: null })
        .onConflictDoUpdate({ target: contactPolicies.personId, set: { doNotContact: true, reason: input.reason, source: "human", setAt: input.now, clearedAt: null, updatedAt: input.now } });

      const owned = await tx.select().from(records).where(and(eq(records.personId, input.personId), eq(records.organizationId, input.organizationId))).for("update");
      const recordIds = owned.map((r) => r.id);
      for (const record of owned) {
        const version = record.contextVersion + 1;
        await tx
          .update(records)
          .set({ workflowState: afterPersonDecision(record.workflowState), nextActionAt: null, contextVersion: version })
          .where(eq(records.id, record.id));
        await tx.insert(events).values({
          organizationId: input.organizationId,
          personId: input.personId,
          recordId: record.id,
          eventType: "contact_policy.enforced",
          actorType: "human",
          actorUserId: input.actorUserId,
          fromData: { workflowState: record.workflowState },
          meta: { policy: "do_not_contact", reason: input.reason },
          contextVersion: version,
        });
      }
      const draftsRetired = await retireOpenDrafts(tx, recordIds, "The person was marked do not contact.");
      await interruptPersonRunsTx(tx, input.organizationId, [input.personId], "do_not_contact", input.now);
      const stopped = await tx
        .update(campaignEnrollments)
        .set({ status: "suppressed", nextSendAt: null, stopReason: "do_not_contact", updatedAt: input.now })
        .where(and(eq(campaignEnrollments.organizationId, input.organizationId), eq(campaignEnrollments.personId, input.personId), inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])))
        .returning({ id: campaignEnrollments.id });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: input.personId,
        eventType: "contact_policy.dnc_set",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: previous ? { doNotContact: previous.doNotContact, reason: previous.reason } : null,
        toData: { doNotContact: true, reason: input.reason },
        meta: { enrollmentsStopped: stopped.length, draftsRetired, records: recordIds.length },
      });
      return { changed: true, doNotContact: true, recordsUpdated: recordIds.length, draftsRetired, enrollmentsStopped: stopped.length };
    }));
  },

  async closeRecord(input) {
    await db.transaction(async (tx) => {
      const record = await lockRecord(tx, input.organizationId, input.recordId);
      if (record.workflowState === "closed") throw new ConflictError("Reply handling is already closed.");
      const version = record.contextVersion + 1;
      await tx.update(records).set({ workflowState: "closed", closedReason: input.reason, nextActionAt: null, contextVersion: version }).where(eq(records.id, record.id));
      await retireOpenDrafts(tx, [record.id], "A person closed reply handling after this draft was written.");
      await interruptRecordRunsTx(tx, input.organizationId, record.id, "record_closed", input.now);
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "workflow.state_changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { workflowState: record.workflowState },
        toData: { workflowState: "closed" },
        meta: { reason: input.reason },
        contextVersion: version,
      });
    });
  },

  async reopenRecord(input) {
    await db.transaction(async (tx) => {
      const record = await lockRecord(tx, input.organizationId, input.recordId);
      if (record.workflowState !== "closed") throw new ConflictError("Reply handling is already open.");
      const next = afterReopen(record.latestInboundMessageId !== null);
      const version = record.contextVersion + 1;
      await tx.update(records).set({ workflowState: next, closedReason: null, contextVersion: version }).where(eq(records.id, record.id));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "workflow.state_changed",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { workflowState: "closed" },
        toData: { workflowState: next },
        meta: { reason: "reopened" },
        contextVersion: version,
      });
    });
  },

  async addNote(input) {
    const { scope } = input;
    let owner: { personId: string; recordId: string | null };
    if (scope.recordId !== undefined) {
      const [record] = await db.select({ id: records.id, personId: records.personId }).from(records).where(and(eq(records.id, scope.recordId), eq(records.organizationId, input.organizationId)));
      if (!record) throw new NotFoundError("Reply handling not found");
      owner = { personId: record.personId, recordId: record.id };
    } else {
      // A note by person works without a reply record, so it is stored with a null record_id.
      const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, scope.personId), eq(people.organizationId, input.organizationId)));
      if (!person) throw new NotFoundError("Person not found");
      owner = { personId: person.id, recordId: null };
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
          // Through the person, only the notes `personNotes` lists: a note on a private-thread-only record is not found.
          scope.recordId !== undefined ? eq(notes.recordId, scope.recordId) : and(eq(notes.personId, scope.personId), onVisibleRecordSql(notes.recordId)),
        ),
      )
      .returning({ id: notes.id });
    return removed.length > 0;
  },

  async replyTypeCatalog(organizationId): Promise<ReplyTypeCatalog> {
    const replyTypeSetId = await replyTypeSetFor(organizationId);
    const [replyTypeSet] = rowsOf<{ id: string; name: string }>(await db.execute(sql`select id, name from reply_type_sets where id = ${replyTypeSetId}`));
    // One grouped count per table. A pick that names a type in more than one column counts once for it.
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        with record_counts as (
          select r.reply_type_id as id, count(*)::int as n from records r
          where r.organization_id = ${organizationId} and r.reply_type_id is not null group by r.reply_type_id
        ), history_counts as (
          select named.id, count(distinct k.id)::int as n
          from reply_type_picks k
          cross join lateral (values (k.previous_reply_type_id), (k.proposed_reply_type_id), (k.applied_reply_type_id)) as named(id)
          where k.organization_id = ${organizationId} and named.id is not null
          group by named.id
        )
        select s.*, coalesce(rc.n, 0) as record_count, coalesce(hc.n, 0) as history_count
        from reply_types s
        left join record_counts rc on rc.id = s.id
        left join history_counts hc on hc.id = s.id
        where s.organization_id = ${organizationId} and s.reply_type_set_id = ${replyTypeSetId}
        order by s.sort_order, s.name`),
    );
    const settings = await settingsOf(replyTypeSetId);
    return {
      replyTypeSet,
      replyTypes: rows
        .map((r) => ({
          id: r.id as string,
          groupKey: r.group_key as ReplyTypeGroup,
          key: r.key as string,
          name: r.name as string,
          description: r.description as string | null,
          classificationGuidance: r.classification_guidance as string | null,
          active: r.active as boolean,
          rules: typeRulesOf({ checkMode: r.check_mode as string, replyDraft: r.reply_draft as boolean, followUps: r.follow_ups as string }),
          systemRole: (r.system_role as ReplyTypeOption["systemRole"]) ?? null,
          sortOrder: Number(r.sort_order),
          recordCount: Number(r.record_count),
          historyCount: Number(r.history_count),
        }))
        .sort(byGroupThenOrder),
      settings,
    };
  },

  async replySettings(organizationId) {
    return settingsOf(await replyTypeSetFor(organizationId));
  },

  async createReplyType(organizationId, input) {
    const replyTypeSetId = await replyTypeSetFor(organizationId);
    const [{ next }] = await db
      .select({ next: sql<number>`coalesce(max(${replyTypes.sortOrder}), -1) + 1` })
      .from(replyTypes)
      .where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, replyTypeSetId)));
    const [row] = await db
      .insert(replyTypes)
      .values({
        organizationId,
        replyTypeSetId,
        groupKey: input.groupKey,
        key: input.key,
        name: input.name,
        description: input.description,
        classificationGuidance: input.classificationGuidance,
        checkMode: input.rules.checkMode,
        replyDraft: input.rules.replyDraft,
        followUps: input.rules.followUps,
        sortOrder: Number(next),
      })
      .onConflictDoNothing()
      .returning({ id: replyTypes.id });
    if (!row) throw new ConflictError(`A reply type with the key "${input.key}" already exists.`);
    return row;
  },

  async updateReplyType(organizationId, id, { rules, ...fields }) {
    const updated = await db
      .update(replyTypes)
      .set({ ...fields, ...rules })
      .where(and(eq(replyTypes.id, id), eq(replyTypes.organizationId, organizationId)))
      .returning({ id: replyTypes.id });
    if (updated.length === 0) throw new NotFoundError("Reply type not found");
  },

  async deleteReplyType(organizationId, id) {
    try {
      const removed = await db.delete(replyTypes).where(and(eq(replyTypes.id, id), eq(replyTypes.organizationId, organizationId))).returning({ id: replyTypes.id });
      if (removed.length === 0) throw new NotFoundError("Reply type not found");
    } catch (error) {
      // The composite foreign key on records stops a delete that raced with a new assignment.
      if (error instanceof NotFoundError) throw error;
      throw new ConflictError("People have this reply type. Change their type first, or archive it.");
    }
  },

  async updateSettings(organizationId, patch) {
    const replyTypeSetId = await replyTypeSetFor(organizationId);
    const { autoApplyConfidence, ...rest } = patch;
    await db
      .update(replyHandlingSettings)
      .set({ ...rest, ...(autoApplyConfidence === undefined ? {} : { autoApplyConfidence: autoApplyConfidence.toFixed(3) }) })
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
