import { sqlState } from "@/platform/db/errors";
import { organizationTimeZone } from "@/contexts/tenancy/infrastructure/drizzle-organization-store";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { db, inTransaction, type DbHandle } from "@/platform/db/client";
import { ConflictError } from "@/shared/errors";
import { campaignEnrollments, campaigns, companies, entityColumns, mailboxes, people, sends } from "@/platform/db/schema";
import { STEPS_EDITABLE, type ArchiveFilter, type CampaignStatus, type CampaignStatusChange, type StepInput } from "../domain/campaign";
import { defaultWorkingHours, startOfLocalDay, type WorkingHours } from "../domain/working-hours";
import { buildVariables } from "../domain/variables";
import { REMOVED_STATUS, STOPPED_ENROLLMENT_STATUSES } from "../domain/enrollment-status";
import { enrollmentVariableColumns, personVariableColumns } from "./enrollment-variables";
import { UNCONFIRMED_AFTER_MINUTES } from "../application/campaign-management";
import { enrollByQueryTx } from "./enrollment-eligibility";
import type { SendResolutionStore } from "../application/send-resolution";
import { filteredScope, sentCount, tabCounts } from "./enrollment-list-sql";
import { inboxThreadsOfPeople } from "./inbox-thread-lookup";
import { resolveUnknownEmailSend } from "../email/infrastructure/drizzle-outreach-store";
import type { CampaignStore, EnrollResult, MailboxRecord, MailboxStore } from "../application/management-ports";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { SEND_COUNTED } from "../domain/send-status";

/** SQL condition for an archive filter on `campaigns`. */
export const archiveCondition = (filter: ArchiveFilter): SQL | undefined =>
  filter === "hide" ? isNull(campaigns.archivedAt) : filter === "only" ? isNotNull(campaigns.archivedAt) : undefined;

/** Sends in status `unknown` of one campaign, on either channel: the total and the oldest `limit`. A person settles them. */
export async function unconfirmedSendsOf(channel: "email" | "linkedin", organizationId: string, id: string, olderThan: Date, limit: number) {
  const where = and(
    eq(sends.organizationId, organizationId),
    eq(sends.channel, channel),
    eq(sends.kind, "campaign"),
    eq(sends.status, "unknown"),
    lt(sends.claimedAt, olderThan),
    eq(campaignEnrollments.campaignId, id),
  );
  const [{ total }] = await db
    .select({ total: count() })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .where(where);
  const rows = await db
    .select({
      sendId: sends.id,
      enrollmentId: sends.enrollmentId,
      personName: people.fullName,
      email: people.email,
      stepNumber: sends.stepNumber,
      mailboxEmail: mailboxes.emailAddress,
      claimedAt: sends.claimedAt,
      note: sends.error,
    })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .innerJoin(people, eq(people.id, campaignEnrollments.personId))
    .leftJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
    .where(where)
    .orderBy(asc(sends.claimedAt), asc(sends.id))
    .limit(limit);
  // The enrollment join and kind='campaign' above leave only sends that have an enrollment and a step.
  return { total, rows: rows.map((r) => ({ ...r, enrollmentId: r.enrollmentId as string, stepNumber: r.stepNumber as number })) };
}

/** A step edit lands only while the campaign is still editable, so a launch that commits first makes the edit miss. */
export const stepsStillEditable = (patch: { steps?: unknown }) => (patch.steps === undefined ? undefined : inArray(campaigns.status, [...STEPS_EDITABLE]));

/** The campaign still has the status and the steps the use case checked: a concurrent change makes the write miss. */
export const checkedStatusChange = (organizationId: string, id: string, change: CampaignStatusChange<unknown>) =>
  and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.status, change.from), sql`${campaigns.steps} = ${JSON.stringify(change.checkedSteps)}::jsonb`);

/** Who moved the campaign: a start records the agent's token (null for a person), and a pause records whether a person paused it. */
export const statusMarks = (change: CampaignStatusChange<unknown>) => {
  const via = change.viaTokenId ?? null;
  // A start or resume restarts the bounce count, and the reason of an earlier breaker pause ends with the pause.
  if (change.to === "active") return { startedViaTokenId: via, personPaused: false, sendsCountedFrom: sql`now()`, bouncePause: null };
  if (change.to === "paused") return { personPaused: via === null };
  return { bouncePause: null };
};

export const drizzleCampaignStore: CampaignStore = {
  transaction: (fn, within) => inTransaction(within, fn),

  async list(organizationId, now = new Date(), archived = "hide") {
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        steps: sql<number>`jsonb_array_length(${campaigns.steps})::int`,
        archivedAt: campaigns.archivedAt,
        createdAt: campaigns.createdAt,
        bouncePause: campaigns.bouncePause,
        enrolled: sql<number>`(count(${campaignEnrollments.id}) filter (where ${campaignEnrollments.status} <> ${REMOVED_STATUS}))::int`,
        stopped: sql<number>`(count(${campaignEnrollments.id}) filter (where ${inArray(campaignEnrollments.status, [...STOPPED_ENROLLMENT_STATUSES])}))::int`,
        replied: sql<number>`(count(${campaignEnrollments.id}) filter (where ${campaignEnrollments.status} = 'replied'))::int`,
        completed: sql<number>`(count(${campaignEnrollments.id}) filter (where ${campaignEnrollments.status} = 'completed'))::int`,
      })
      .from(campaigns)
      .leftJoin(campaignEnrollments, and(eq(campaignEnrollments.campaignId, campaigns.id), eq(campaignEnrollments.organizationId, campaigns.organizationId)))
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.channel, "email"), archiveCondition(archived)))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt));

    const sent = await db
      .select({ campaignId: campaignEnrollments.campaignId, sent: sql<number>`count(*)::int` })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .where(and(eq(sends.organizationId, organizationId), eq(sends.status, "sent")))
      .groupBy(campaignEnrollments.campaignId);
    const sentBy = new Map(sent.map((r) => [r.campaignId, r.sent]));

    const unconfirmed = await db
      .select({ campaignId: campaignEnrollments.campaignId, n: sql<number>`count(*)::int` })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .where(and(eq(sends.organizationId, organizationId), eq(sends.channel, "email"), eq(sends.kind, "campaign"), eq(sends.status, "unknown"), lt(sends.claimedAt, new Date(now.getTime() - UNCONFIRMED_AFTER_MINUTES * 60_000))))
      .groupBy(campaignEnrollments.campaignId);
    const unconfirmedBy = new Map(unconfirmed.map((r) => [r.campaignId, r.n]));

    return rows.map((r) => ({ ...r, status: r.status as CampaignStatus, sent: sentBy.get(r.id) ?? 0, unconfirmed: unconfirmedBy.get(r.id) ?? 0 }));
  },

  unconfirmedSends: (organizationId, id, olderThan, limit) => unconfirmedSendsOf("email", organizationId, id, olderThan, limit),

  async get(organizationId, id, tx) {
    const [row] = await (tx ?? db)
      .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, steps: campaigns.steps, archivedAt: campaigns.archivedAt, createdAt: campaigns.createdAt, bouncePause: campaigns.bouncePause })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "email")));
    return row ? { ...row, status: row.status as CampaignStatus, steps: row.steps as StepInput[] } : null;
  },

  async create(organizationId, input, tx) {
    const [row] = await (tx ?? db)
      .insert(campaigns)
      .values({ organizationId, channel: "email", name: input.name, status: "draft", steps: input.steps, createdBy: input.createdBy })
      .returning({ id: campaigns.id });
    return row.id;
  },

  async furthestStep(organizationId, id, tx) {
    const [row] = await (tx ?? db)
      .select({ furthest: sql<number>`coalesce(max(${campaignEnrollments.currentStep}), 0)::int` })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, id)));
    return row.furthest;
  },

  async update(organizationId, id, patch, tx) {
    const set = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.steps !== undefined ? { steps: patch.steps } : {}) };
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) return true;
    const rows = await (tx ?? db)
      .update(campaigns)
      .set(set)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), stepsStillEditable(patch)))
      .returning({ id: campaigns.id });
    return rows.length > 0;
  },

  async setStatus(organizationId, id, change, handle = db) {
    const rows = await handle.update(campaigns).set({ status: change.to, ...statusMarks(change) }).where(checkedStatusChange(organizationId, id, change)).returning({ id: campaigns.id });
    return rows.length > 0;
  },

  async delete(organizationId, id, audit) {
    return db.transaction(async (tx) => {
      const rows = await tx.delete(campaigns).where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.status, "draft"))).returning({ id: campaigns.id });
      if (rows.length > 0) await recordAudit(tx, audit);
      return rows.length > 0;
    });
  },

  async setArchived(organizationId, id, archived) {
    // Archive only a completed campaign, in the same statement, so a status change cannot slip in between the check and the write.
    const rows = await db
      .update(campaigns)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), archived ? eq(campaigns.status, "completed") : undefined))
      .returning({ id: campaigns.id });
    return rows.length > 0;
  },

  enroll(organizationId, id, filter, handle): Promise<EnrollResult> {
    return inTransaction(handle, async (tx) => {
      const { counts } = await enrollByQueryTx(tx, organizationId, id, "email", filter);
      return { ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoEmail: counts.skippedMissingIdentity };
    });
  },

  async listEnrollments(organizationId, id, query) {
    const where = filteredScope(organizationId, id, query);
    const [{ total }] = await db
      .select({ total: count() })
      .from(campaignEnrollments)
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(where);
    const rows = await db
      .select({
        enrollmentId: campaignEnrollments.id,
        personId: campaignEnrollments.personId,
        personName: people.fullName,
        email: people.email,
        status: campaignEnrollments.status,
        currentStep: campaignEnrollments.currentStep,
        nextSendAt: campaignEnrollments.nextSendAt,
        lastSentAt: campaignEnrollments.lastSentAt,
        stopReason: campaignEnrollments.stopReason,
      })
      .from(campaignEnrollments)
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(where)
      .orderBy(desc(campaignEnrollments.createdAt), desc(campaignEnrollments.id))
      .limit(query.pageSize)
      .offset((Math.max(1, query.page) - 1) * query.pageSize);
    const repliedPeople = [...new Set(rows.filter((r) => r.status === "replied").map((r) => r.personId))];
    const threads = await inboxThreadsOfPeople(organizationId, "email", repliedPeople);
    const [counts, sent] = await Promise.all([tabCounts(organizationId, id, query.campaignStatus), sentCount(organizationId, id)]);
    return { rows: rows.map((r) => ({ ...r, inboxThreadId: threads.get(r.personId) ?? null })), total, counts, sent };
  },

  async waitingOnUnavailableMailbox(organizationId, id) {
    const [row] = await db
      .select({ n: count() })
      .from(campaignEnrollments)
      .leftJoin(mailboxes, and(eq(mailboxes.id, campaignEnrollments.mailboxId), eq(mailboxes.organizationId, campaignEnrollments.organizationId)))
      .where(
        and(
          eq(campaignEnrollments.organizationId, organizationId),
          eq(campaignEnrollments.campaignId, id),
          eq(campaignEnrollments.status, "active"),
          sql`(${mailboxes.id} is null or ${mailboxes.status} <> 'connected')`,
        ),
      );
    return row.n;
  },

  async sampleVariables(organizationId, id, tx) {
    const handle = tx ?? db;
    const pick = async (enrolledIn: string | null) => {
      const query = handle.select(personVariableColumns).from(people).leftJoin(companies, eq(companies.id, people.companyId));
      const rows = enrolledIn
        ? await handle
            .select(enrollmentVariableColumns)
            .from(people)
            .leftJoin(companies, eq(companies.id, people.companyId))
            .innerJoin(campaignEnrollments, and(eq(campaignEnrollments.personId, people.id), eq(campaignEnrollments.campaignId, enrolledIn)))
            .where(and(eq(people.organizationId, organizationId), sql`${people.email} is not null`))
            .orderBy(asc(campaignEnrollments.createdAt))
            .limit(1)
        : await query
            .where(and(eq(people.organizationId, organizationId), sql`${people.email} is not null`))
            .orderBy(asc(people.createdAt))
            .limit(1);
      return rows[0];
    };
    const person = (await pick(id)) ?? (await pick(null));
    if (!person) return null;
    return buildVariables(person, await columnLabels(organizationId, tx));
  },

  async liveLeadVariables(organizationId, id, limit, tx) {
    const rows = await (tx ?? db)
      .select(enrollmentVariableColumns)
      .from(campaignEnrollments)
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, id), ne(campaignEnrollments.status, "removed")))
      .orderBy(asc(campaignEnrollments.createdAt), asc(campaignEnrollments.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const labels = await columnLabels(organizationId, tx);
    return rows.map((row) => buildVariables(row, labels));
  },
};

async function columnLabels(organizationId: string, tx?: DbHandle) {
  const columns = await (tx ?? db)
    .select({ key: entityColumns.key, name: entityColumns.name })
    .from(entityColumns)
    .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people")));
  return new Map(columns.map((c) => [c.key, c.name]));
}

const mailboxColumns = {
  id: mailboxes.id,
  emailAddress: mailboxes.emailAddress,
  displayName: mailboxes.displayName,
  status: mailboxes.status,
  lastError: mailboxes.lastError,
  lastTestedAt: mailboxes.lastTestedAt,
  dailySendLimit: mailboxes.dailySendLimit,
  signatureHtml: mailboxes.signatureHtml,
  workingHours: mailboxes.workingHours,
  createdAt: mailboxes.createdAt,
};

export const drizzleMailboxStore: MailboxStore = {
  async list(organizationId, now) {
    const rows = await db.select(mailboxColumns).from(mailboxes).where(eq(mailboxes.organizationId, organizationId)).orderBy(asc(mailboxes.createdAt));
    const waiting = await db
      .select({ mailboxId: campaignEnrollments.mailboxId, n: count() })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.status, "active"), eq(campaignEnrollments.channel, "email")))
      .groupBy(campaignEnrollments.mailboxId);
    const waitingBy = new Map(waiting.map((r) => [r.mailboxId, r.n]));
    // A mailbox without its own hours sends by the organization's time zone, so show and count by that too.
    const orgZone = await organizationTimeZone(organizationId);
    return Promise.all(
      rows.map(async (row): Promise<MailboxRecord> => {
        const hours = (row.workingHours as WorkingHours | null) ?? defaultWorkingHours(orgZone);
        const zone = hours.timeZone;
        const [{ sentToday }] = await db
          .select({ sentToday: sql<number>`count(*)::int` })
          .from(sends)
          .where(
            and(
              eq(sends.mailboxId, row.id),
              inArray(sends.status, SEND_COUNTED),
              sql`${sends.claimedAt} >= ${startOfLocalDay(now, zone).toISOString()}::timestamptz`,
            ),
          );
        return { ...row, workingHours: hours, ownHours: row.workingHours !== null, sentToday, waitingLeads: waitingBy.get(row.id) ?? 0 };
      }),
    );
  },

  async get(organizationId, id) {
    const [row] = await db.select(mailboxColumns).from(mailboxes).where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)));
    if (!row) return null;
    const waitingLeads = await drizzleMailboxStore.activeEnrollmentCount(organizationId, id);
    return { ...row, workingHours: row.workingHours as WorkingHours | null, ownHours: row.workingHours !== null, sentToday: 0, waitingLeads };
  },

  async insert(organizationId, input) {
    try {
      const [row] = await db
        .insert(mailboxes)
        .values({ organizationId, emailAddress: input.emailAddress, displayName: input.displayName, status: "connected", lastTestedAt: input.testedAt })
        .returning({ id: mailboxes.id });
      return row.id;
    } catch (error) {
      if (sqlState(error) === "23505") throw new ConflictError("This address is already connected to a mailbox.");
      throw error;
    }
  },

  async update(organizationId, id, patch) {
    const set = {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.dailySendLimit !== undefined ? { dailySendLimit: patch.dailySendLimit } : {}),
      ...(patch.signatureHtml !== undefined ? { signatureHtml: patch.signatureHtml } : {}),
      ...(patch.workingHours !== undefined ? { workingHours: patch.workingHours } : {}),
    };
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) return;
    await db
      .update(mailboxes)
      .set(set)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)));
  },

  async setStatus(organizationId, id, next, error, testedAt, from) {
    await db
      .update(mailboxes)
      // The unable period starts the first time the status leaves connected and ends when it returns.
      .set({ status: next, lastError: error, lastTestedAt: testedAt, unavailableSince: next === "connected" ? null : sql`coalesce(${mailboxes.unavailableSince}, now())` })
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id), inArray(mailboxes.status, [...from])));
  },

  async activeEnrollmentCount(organizationId, id) {
    const [row] = await db
      .select({ n: count() })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.mailboxId, id), eq(campaignEnrollments.status, "active")));
    return row.n;
  },

  async soleSenderCampaigns(organizationId, id) {
    const rows = await db.execute<{ name: string }>(sql`
      select c.name from campaigns c
      join campaign_senders cs on cs.campaign_id = c.id and cs.mailbox_id = ${id}
      where c.organization_id = ${organizationId} and c.channel = 'email' and c.status <> 'completed'
        and not exists (select 1 from campaign_senders o where o.campaign_id = c.id and o.id <> cs.id)
      order by c.name`);
    return [...rows].map((r) => r.name);
  },

  async delete(organizationId, id) {
    try {
      await db.delete(mailboxes).where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.id, id)));
    } catch (error) {
      if (sqlState(error) === "23503") throw new ConflictError("This mailbox has sending history, so it cannot be deleted. Disable it instead.");
      throw error;
    }
  },

  async countConnected(organizationId, tx) {
    const [row] = await (tx ?? db)
      .select({ n: count() })
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.status, "connected")));
    return row.n;
  },

  async firstConnectedSignature(organizationId) {
    const [row] = await db
      .select({ signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes)
      .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.status, "connected")))
      .orderBy(asc(mailboxes.createdAt))
      .limit(1);
    return row?.signatureHtml ?? null;
  },
};

export const drizzleSendResolutionStore: SendResolutionStore = {
  resolve: resolveUnknownEmailSend,
};
