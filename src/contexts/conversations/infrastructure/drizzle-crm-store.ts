import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { interruptPersonRunsTx, interruptRecordRunsTx } from "../after-reply/infrastructure/sequence-stop";
import { restartRecordWorkTx } from "./restart-record-work";
import {
  aiJobs,
  campaignEnrollments,
  campaigns,
  classifications,
  companies,
  contactPolicies,
  conversations,
  drafts,
  events,
  identityExceptions,
  messages,
  notes,
  people,
  pipelineSettings,
  records,
  sendAttempts,
  subcategories,
  suppressionList,
  users,
} from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type {
  ClassificationEntry,
  CrmStore,
  DncResult,
  DraftEntry,
  EventEntry,
  NoteEntry,
  RecordDetail,
  Taxonomy,
} from "../application/crm-ports";
import { CRM_CATEGORIES, checkStageMove, type CategoryKey } from "../domain/crm";
import { defaultPipelineId, type Tx } from "./drizzle-conversation-store";
import { onVisibleRecordSql, publicConversation, visibleClassificationSql, visibleDraftSql, visibleRecordSql } from "@/platform/db/conversation-visibility";
import { draftCanBecome } from "./reply-store-shared";
import { LIVE_ENROLLMENT_STATUSES } from "@/contexts/outreach/domain/enrollment-status";

const CATEGORY_ORDER = new Map<string, number>(CRM_CATEGORIES.map((c, i) => [c.key, i]));
const rowsOf = <T>(result: unknown) => result as unknown as T[];
const personName = (p: { fullName: string | null; firstName: string | null }) => p.fullName ?? p.firstName;

async function pipelineFor(organizationId: string) {
  return db.transaction(async (tx) => {
    const id = await defaultPipelineId(tx, organizationId);
    const settings = (await tx.select().from(pipelineSettings).where(eq(pipelineSettings.pipelineId, id)))[0];
    if (!settings) await tx.insert(pipelineSettings).values({ pipelineId: id, organizationId }).onConflictDoNothing();
    return id;
  });
}

async function lockRecord(tx: Tx, organizationId: string, recordId: string) {
  const [row] = await tx.select().from(records).where(and(eq(records.id, recordId), eq(records.organizationId, organizationId))).for("update");
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

/** The constraint a driver error names, also under a wrapping error's `cause`. */
function constraintOf(error: unknown): string | null {
  let current = error as { code?: unknown; constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current.code === "23503" && typeof current.constraint_name === "string") return current.constraint_name;
    current = current.cause as typeof current;
  }
  return null;
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
    const constraint = constraintOf(error);
    if (constraint?.startsWith("contact_policies_person_id") || constraint?.startsWith("events_person_id")) throw new NotFoundError("Person not found");
    throw error;
  }
}

export const drizzleCrmStore: CrmStore = {
  async recordDetail(organizationId, recordId): Promise<RecordDetail | null> {
    const [head] = await db
      .select({ record: records, person: people, company: companies.name })
      .from(records)
      .innerJoin(people, eq(people.id, records.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId), visibleRecordSql("records")));
    if (!head) return null;
    const { record, person } = head;

    const subs = await db.select().from(subcategories).where(and(eq(subcategories.organizationId, organizationId), eq(subcategories.pipelineId, record.pipelineId)));
    const subName = (id: string | null) => subs.find((s) => s.id === id)?.name ?? null;

    const [convs, cls, draftRows, eventRows, noteRows, enrollmentRows, policy, suppressed] = await Promise.all([
      db
        .select({ id: conversations.id, channel: conversations.channel, accountRef: conversations.accountRef, status: conversations.status })
        .from(conversations)
        .where(and(eq(conversations.recordId, recordId), eq(conversations.organizationId, organizationId), publicConversation))
        .orderBy(conversations.createdAt),
      db
        .select({ c: classifications, conversationId: messages.conversationId })
        .from(classifications)
        .innerJoin(messages, eq(messages.id, classifications.messageId))
        .where(and(eq(classifications.recordId, recordId), eq(classifications.organizationId, organizationId), visibleClassificationSql("classifications")))
        .orderBy(desc(classifications.createdAt))
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

    const classificationEntries = cls.map(({ c, conversationId }): ClassificationEntry => {
      const latest = c.messageId === record.latestInboundMessageId;
      const applied = ["auto_applied", "accepted", "overridden"].includes(c.status) && c.appliedCategoryKey !== null;
      return {
        id: c.id,
        status: c.status,
        messageId: c.messageId,
        conversationId,
        previous: { categoryKey: c.previousCategoryKey, name: subName(c.previousSubcategoryId) },
        proposed: { categoryKey: c.proposedCategoryKey, name: subName(c.proposedSubcategoryId) },
        applied: { categoryKey: c.appliedCategoryKey, name: subName(c.appliedSubcategoryId) },
        confidence: c.confidence === null ? null : Number(c.confidence),
        reasoning: c.reasoning,
        error: c.error,
        provider: c.provider,
        acknowledged: c.acknowledgedAt !== null,
        createdAt: c.createdAt,
        latest,
        canUndo: latest && applied,
        canAcknowledge: c.acknowledgedAt === null && (c.status === "auto_applied" || c.status === "failed"),
      };
    });

    return {
      record: {
        id: record.id,
        pipelineId: record.pipelineId,
        categoryKey: record.categoryKey,
        subcategoryId: record.subcategoryId,
        subcategoryName: subName(record.subcategoryId),
        categorySource: record.categorySource,
        categoryLocked: record.categoryLocked,
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
      classifications: classificationEntries,
      drafts: draftRows.map(
        (d): DraftEntry => ({
          id: d.id,
          conversationId: d.conversationId,
          channel: d.channel,
          status: d.status,
          subject: d.subject,
          preview: (d.editedBodyText ?? d.aiBodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          revision: d.revision,
          createdAt: d.createdAt,
          attemptId: attemptOf.get(d.id) ?? null,
        }),
      ),
      events: eventRows.map(({ e, actorName }): EventEntry => ({ id: e.id, eventType: e.eventType, actorType: e.actorType, actorName, createdAt: e.createdAt, fromData: e.fromData, toData: e.toData, meta: e.meta })),
      notes: noteRows.map(({ n, authorName }): NoteEntry => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, authorName, createdBy: n.createdBy })),
      enrollments: enrollmentRows,
      stages: subs
        .filter((s) => s.active)
        .sort((a, b) => (CATEGORY_ORDER.get(a.categoryKey) ?? 9) - (CATEGORY_ORDER.get(b.categoryKey) ?? 9) || (a.stageRank ?? 1000) - (b.stageRank ?? 1000) || a.sortOrder - b.sortOrder)
        .map((s) => ({ id: s.id, key: s.key, categoryKey: s.categoryKey as CategoryKey, name: s.name, stageRank: s.stageRank })),
    };
  },

  async draftIdForAttempt(organizationId, attemptId) {
    const [row] = await db.select({ draftId: sendAttempts.draftId }).from(sendAttempts).where(and(eq(sendAttempts.id, attemptId), eq(sendAttempts.organizationId, organizationId)));
    return row?.draftId ?? null;
  },

  async moveStage(input) {
    return db.transaction(async (tx) => {
      const before = await lockRecord(tx, input.organizationId, input.recordId);
      let sub: typeof subcategories.$inferSelect | undefined;
      if (input.subcategoryId) {
        [sub] = await tx
          .select()
          .from(subcategories)
          .where(and(eq(subcategories.id, input.subcategoryId), eq(subcategories.organizationId, input.organizationId), eq(subcategories.pipelineId, before.pipelineId)));
        if (!sub) throw new NotFoundError("Subcategory not found");
        if (sub.categoryKey !== input.categoryKey) throw new ValidationError("That subcategory belongs to another category.");
        if (!sub.active) throw new ConflictError("An archived subcategory cannot be assigned.");
      }
      const { categoryLocked } = checkStageMove({
        before: { categoryKey: before.categoryKey, subcategoryId: before.subcategoryId, categoryLocked: before.categoryLocked, contextVersion: before.contextVersion, workflowState: before.workflowState },
        target: { categoryKey: input.categoryKey, subcategoryId: input.subcategoryId },
        expectedContextVersion: input.expectedContextVersion,
        confirmUnlock: input.confirmUnlock,
      });
      await tx
        .update(records)
        .set({ categoryKey: input.categoryKey, subcategoryId: input.subcategoryId, categorySource: "human", categoryLocked, workflowState: "action_required", nextActionAt: null })
        .where(eq(records.id, before.id));
      // The old stage's run and drafts end, the version goes up, and the new stage's sequence starts, all in this commit.
      const { contextVersion: version, draftsRetired } = await restartRecordWorkTx(tx, {
        organizationId: input.organizationId,
        recordId: before.id,
        reason: "stage_moved",
        draftReason: "A person moved the reply to another category after this draft was written.",
        now: input.now,
        actorUserId: input.actorUserId,
      });
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: before.personId,
        recordId: before.id,
        eventType: "stage.moved",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { categoryKey: before.categoryKey, subcategoryId: before.subcategoryId, categorySource: before.categorySource, categoryLocked: before.categoryLocked },
        toData: { categoryKey: input.categoryKey, subcategoryId: input.subcategoryId, categorySource: "human", categoryLocked },
        meta: { note: input.note, occurredAt: input.occurredAt.toISOString(), unlockedCustomer: before.categoryLocked && input.categoryKey !== "customer" },
        contextVersion: version,
      });
      return { recordId: before.id, personId: before.personId, categoryKey: input.categoryKey, subcategoryKey: sub?.key ?? null, contextVersion: version, draftsRetired };
    });
  },

  async undoClassification(input) {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ recordId: classifications.recordId })
        .from(classifications)
        .where(and(eq(classifications.id, input.classificationId), eq(classifications.organizationId, input.organizationId)));
      if (!candidate) throw new NotFoundError("Classification not found");
      const record = await lockRecord(tx, input.organizationId, candidate.recordId);
      const [cls] = await tx.select().from(classifications).where(eq(classifications.id, input.classificationId)).for("update");
      if (cls.messageId !== record.latestInboundMessageId) throw new ConflictError("Only the classification of the latest inbound message can be undone.");
      if (!cls.appliedCategoryKey || !["auto_applied", "accepted", "overridden"].includes(cls.status)) throw new ConflictError("This classification has no applied change to undo.");
      if (record.categoryKey !== cls.appliedCategoryKey || record.subcategoryId !== cls.appliedSubcategoryId) {
        throw new ConflictError("A person moved the reply to another category after this classification. Change the category by hand.");
      }
      const version = record.contextVersion + 1;
      const previous = cls.previousCategoryKey;
      await tx
        .update(records)
        .set({
          categoryKey: previous,
          subcategoryId: previous ? cls.previousSubcategoryId : null,
          categorySource: previous ? "human" : null,
          categoryLocked: previous === "customer",
          workflowState: record.workflowState === "closed" ? "closed" : "action_required",
          nextActionAt: null,
          contextVersion: version,
        })
        .where(eq(records.id, record.id));
      await tx.update(classifications).set({ status: "rejected", acknowledgedAt: input.now }).where(eq(classifications.id, cls.id));
      // A draft job that has not run yet would write a reply for the classification a person just rejected.
      await tx
        .update(aiJobs)
        .set({ status: "failed", failedAt: input.now, lastError: "The classification was undone before the draft was written." })
        .where(and(eq(aiJobs.organizationId, input.organizationId), eq(aiJobs.kind, "initial_draft"), eq(aiJobs.entityId, cls.id), eq(aiJobs.status, "queued")));
      const draftsRetired = await retireOpenDrafts(tx, [record.id], "The classification was undone after this draft was written.");
      // The run started for the classification a person just rejected. It ends in this commit and keeps no follow-up drafting.
      await interruptRecordRunsTx(tx, input.organizationId, record.id, "classification_undone", input.now);
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "classification.undone",
        actorType: "human",
        actorUserId: input.actorUserId,
        fromData: { categoryKey: record.categoryKey, subcategoryId: record.subcategoryId },
        toData: { categoryKey: previous, subcategoryId: previous ? cls.previousSubcategoryId : null },
        meta: { classificationId: cls.id },
        contextVersion: version,
      });
      return { recordId: record.id, draftsRetired };
    });
  },

  async acknowledgeClassification(input) {
    await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ recordId: classifications.recordId })
        .from(classifications)
        .where(and(eq(classifications.id, input.classificationId), eq(classifications.organizationId, input.organizationId)));
      if (!candidate) throw new NotFoundError("Classification not found");
      const record = await lockRecord(tx, input.organizationId, candidate.recordId);
      const [cls] = await tx.select().from(classifications).where(eq(classifications.id, input.classificationId)).for("update");
      if (cls.acknowledgedAt) return;
      if (cls.status === "proposed") throw new ConflictError("Accept or change the AI's suggestion instead of acknowledging it.");
      await tx.update(classifications).set({ acknowledgedAt: input.now }).where(eq(classifications.id, cls.id));
      await tx.insert(events).values({
        organizationId: input.organizationId,
        personId: record.personId,
        recordId: record.id,
        eventType: "classification.acknowledged",
        actorType: "human",
        actorUserId: input.actorUserId,
        meta: { classificationId: cls.id },
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
          .set({ workflowState: record.workflowState === "closed" ? "closed" : "action_required", nextActionAt: null, contextVersion: version })
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
      const next = record.latestInboundMessageId ? "action_required" : "idle";
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

  async taxonomy(organizationId): Promise<Taxonomy> {
    const pipelineId = await pipelineFor(organizationId);
    const [pipeline] = rowsOf<{ id: string; name: string }>(await db.execute(sql`select id, name from pipelines where id = ${pipelineId}`));
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select s.*,
          (select count(*)::int from records r where r.subcategory_id = s.id) as record_count,
          (select count(*)::int from classifications k
            where k.organization_id = s.organization_id and s.id in (k.previous_subcategory_id, k.proposed_subcategory_id, k.applied_subcategory_id)) as history_count
        from subcategories s
        where s.organization_id = ${organizationId} and s.pipeline_id = ${pipelineId}
        order by s.sort_order, s.name`),
    );
    const [settings] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.pipelineId, pipelineId));
    return {
      pipeline,
      subcategories: rows
        .map((r) => ({
          id: r.id as string,
          categoryKey: r.category_key as CategoryKey,
          key: r.key as string,
          name: r.name as string,
          description: r.description as string | null,
          classificationGuidance: r.classification_guidance as string | null,
          active: r.active as boolean,
          reviewRequired: r.review_required as boolean,
          stageRank: r.stage_rank as number | null,
          sortOrder: Number(r.sort_order),
          recordCount: Number(r.record_count),
          historyCount: Number(r.history_count),
        }))
        .sort((a, b) => (CATEGORY_ORDER.get(a.categoryKey) ?? 9) - (CATEGORY_ORDER.get(b.categoryKey) ?? 9) || (a.stageRank ?? 1000) - (b.stageRank ?? 1000) || a.sortOrder - b.sortOrder),
      settings: {
        autoApplyConfidence: Number(settings.autoApplyConfidence),
        reviewOther: settings.reviewOther,
        customerRequiresReview: settings.customerRequiresReview,
        draftInstructions: settings.draftInstructions,
        classificationInstructions: settings.classificationInstructions,
      },
    };
  },

  async createSubcategory(organizationId, input) {
    const pipelineId = await pipelineFor(organizationId);
    const [{ next }] = await db
      .select({ next: sql<number>`coalesce(max(${subcategories.sortOrder}), -1) + 1` })
      .from(subcategories)
      .where(and(eq(subcategories.organizationId, organizationId), eq(subcategories.pipelineId, pipelineId)));
    const [row] = await db
      .insert(subcategories)
      .values({
        organizationId,
        pipelineId,
        categoryKey: input.categoryKey,
        key: input.key,
        name: input.name,
        description: input.description,
        classificationGuidance: input.classificationGuidance,
        reviewRequired: input.reviewRequired,
        stageRank: input.stageRank,
        sortOrder: Number(next),
      })
      .onConflictDoNothing()
      .returning({ id: subcategories.id });
    if (!row) throw new ConflictError(`A subcategory with the key "${input.key}" already exists.`);
    return row;
  },

  async updateSubcategory(organizationId, id, patch) {
    const updated = await db
      .update(subcategories)
      .set(patch)
      .where(and(eq(subcategories.id, id), eq(subcategories.organizationId, organizationId)))
      .returning({ id: subcategories.id });
    if (updated.length === 0) throw new NotFoundError("Subcategory not found");
  },

  async deleteSubcategory(organizationId, id) {
    try {
      const removed = await db.delete(subcategories).where(and(eq(subcategories.id, id), eq(subcategories.organizationId, organizationId))).returning({ id: subcategories.id });
      if (removed.length === 0) throw new NotFoundError("Subcategory not found");
    } catch (error) {
      // The composite foreign key on records stops a delete that raced with a new assignment.
      if (error instanceof NotFoundError) throw error;
      throw new ConflictError("People are in this subcategory. Move them first, or archive it.");
    }
  },

  async updateSettings(organizationId, patch) {
    const pipelineId = await pipelineFor(organizationId);
    const { autoApplyConfidence, ...rest } = patch;
    await db
      .update(pipelineSettings)
      .set({ ...rest, ...(autoApplyConfidence === undefined ? {} : { autoApplyConfidence: autoApplyConfidence.toFixed(3) }) })
      .where(and(eq(pipelineSettings.pipelineId, pipelineId), eq(pipelineSettings.organizationId, organizationId)));
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
