import { unconfirmedSendsOf } from "../../infrastructure/drizzle-management-stores";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db, inTransaction, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns, channelSettings, companies, entityColumns, linkedinAccounts, linkedinEnrollmentDetails, people, sends } from "@/platform/db/schema";
import type { LinkedInCampaignStore, LinkedInEnrollResult } from "../application/linkedin-campaigns";
import { drizzleCrossCampaignNotices } from "../../infrastructure/drizzle-cross-campaign-notices";
import { enrollByQueryTx, enrollPickedTx } from "../../infrastructure/enrollment-eligibility";
import { archiveCondition, checkedStatusChange, statusMarks, stepsStillEditable } from "../../infrastructure/drizzle-management-stores";
import type { CampaignStatus } from "../../domain/campaign";
import { REMOVED_STATUS } from "../../domain/enrollment-status";
import { retriesUsed } from "../../domain/enrollment-list";
import { filteredScope, sentCount, tabCounts } from "../../infrastructure/enrollment-list-sql";
import { inboxThreadsOfPeople } from "../../infrastructure/inbox-thread-lookup";
import { dailyInviteLimit, linkedinRules, profileUrlFor, type LinkedInStep } from "../domain/linkedin";
import { buildVariables } from "../../domain/variables";
import { enrollmentVariableColumns, personVariableColumns } from "../../infrastructure/enrollment-variables";
import { startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { SEND_COUNTED } from "../../domain/send-status";

const DAY_MS = 86_400_000;

export const drizzleLinkedInCampaignStore: LinkedInCampaignStore = {
  unconfirmedSends: (organizationId, id, olderThan, limit) => unconfirmedSendsOf("linkedin", organizationId, id, olderThan, limit),

  transaction: (fn, within) => inTransaction(within, fn),

  async list(organizationId, archived = "hide") {
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        steps: campaigns.steps,
        archivedAt: campaigns.archivedAt,
        createdAt: campaigns.createdAt,
        createdBy: campaigns.createdBy,
        enrolled: sql<number>`(count(${campaignEnrollments.id}) filter (where ${campaignEnrollments.status} <> ${REMOVED_STATUS}))::int`,
        invited: sql<number>`(count(${linkedinEnrollmentDetails.enrollmentId}) filter (where ${linkedinEnrollmentDetails.connectionState} <> 'none'))::int`,
        connected: sql<number>`(count(${linkedinEnrollmentDetails.enrollmentId}) filter (where ${linkedinEnrollmentDetails.connectionState} = 'connected'))::int`,
        replied: sql<number>`(count(${campaignEnrollments.id}) filter (where ${campaignEnrollments.status} = 'replied'))::int`,
      })
      .from(campaigns)
      .leftJoin(campaignEnrollments, and(eq(campaignEnrollments.campaignId, campaigns.id), eq(campaignEnrollments.organizationId, campaigns.organizationId)))
      .leftJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.channel, "linkedin"), archiveCondition(archived)))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt));
    return rows.map((r) => ({ ...r, status: r.status as CampaignStatus, steps: r.steps as unknown as LinkedInStep[] }));
  },

  async get(organizationId, id, tx) {
    const [row] = await (tx ?? db)
      .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, steps: campaigns.steps, archivedAt: campaigns.archivedAt, createdAt: campaigns.createdAt, createdBy: campaigns.createdBy })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "linkedin")));
    return row ? { ...row, status: row.status as CampaignStatus, steps: row.steps as unknown as LinkedInStep[] } : null;
  },

  async create(organizationId, input, tx) {
    const [row] = await (tx ?? db)
      .insert(campaigns)
      .values({ organizationId, channel: "linkedin", name: input.name, status: "draft", steps: input.steps as never, createdBy: input.createdBy })
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

  async update(organizationId, id, patch, handle = db) {
    const set = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.steps !== undefined ? { steps: patch.steps as never } : {}) };
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) return true;
    const rows = await handle
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
    const rows = await db
      .update(campaigns)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "linkedin"), archived ? eq(campaigns.status, "completed") : undefined))
      .returning({ id: campaigns.id });
    return rows.length > 0;
  },

  enroll(organizationId, id, filter, handle): Promise<LinkedInEnrollResult> {
    return inTransaction(handle, async (tx) => {
      const { addedPersonIds, counts } = await enrollByQueryTx(tx, organizationId, id, "linkedin", filter);
      return { ...(filter.collectIds ? { addedPersonIds } : {}), ...counts, alreadyEnrolled: counts.skippedDuplicate, skippedNoProfile: counts.skippedMissingIdentity };
    });
  },

  async countConnectedAccounts(organizationId, tx) {
    const rows = await (tx ?? db)
      .select({ id: linkedinAccounts.id })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.status, "connected")));
    return rows.length;
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
        firstName: people.firstName,
        slug: people.linkedinSlug,
        profileUrl: linkedinEnrollmentDetails.profileUrl,
        status: campaignEnrollments.status,
        stopReason: campaignEnrollments.stopReason,
        currentStep: campaignEnrollments.currentStep,
        connectionState: sql<string>`coalesce(${linkedinEnrollmentDetails.connectionState}, 'none')`,
        nextSendAt: campaignEnrollments.nextSendAt,
        lastSentAt: campaignEnrollments.lastSentAt,
        lastName: people.lastName,
        title: people.title,
        phone: people.phone,
        email: people.email,
        custom: people.custom,
        mergeFields: campaignEnrollments.mergeFields,
        companyName: companies.name,
        companyDomain: companies.domain,
        linkedinUrl: people.linkedinUrl,
        raw: people.raw,
        companyLinkedinUrl: companies.linkedinUrl,
        companyRaw: companies.raw,
        accountName: sql<string | null>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username})`,
        resolveLastError: linkedinEnrollmentDetails.resolveLastError,
      })
      .from(campaignEnrollments)
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .leftJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
      .leftJoin(linkedinAccounts, and(eq(linkedinAccounts.id, campaignEnrollments.linkedinAccountId), eq(linkedinAccounts.organizationId, campaignEnrollments.organizationId)))
      .where(where)
      .orderBy(desc(campaignEnrollments.createdAt), desc(campaignEnrollments.id))
      .limit(query.pageSize)
      .offset((Math.max(1, query.page) - 1) * query.pageSize);
    const sendRows = rows.length
      ? await db
          .select({
            enrollmentId: sends.enrollmentId,
            stepNumber: sends.stepNumber,
            status: sends.status,
            attempt: sends.attempt,
            sentAt: sends.sentAt,
            claimedAt: sends.claimedAt,
            body: sends.body,
            error: sends.error,
          })
          .from(sends)
          .where(and(eq(sends.organizationId, organizationId), inArray(sends.enrollmentId, rows.map((r) => r.enrollmentId))))
          .orderBy(asc(sends.stepNumber))
      : [];
    const sendsOf = new Map<string, typeof sendRows>();
    for (const send of sendRows) sendsOf.set(send.enrollmentId as string, [...(sendsOf.get(send.enrollmentId as string) ?? []), send]);
    const columns = await db
      .select({ key: entityColumns.key, name: entityColumns.name })
      .from(entityColumns)
      .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people")));
    const labels = new Map(columns.map((c) => [c.key, c.name]));
    const cross = await drizzleCrossCampaignNotices.leadContext(organizationId, id, [...new Set(rows.map((r) => r.personId))]);
    const repliedPeople = [...new Set(rows.filter((r) => r.status === "replied").map((r) => r.personId))];
    const inboxThreads = await inboxThreadsOfPeople(organizationId, "linkedin", repliedPeople);
    const [counts, sent] = await Promise.all([tabCounts(organizationId, id, query.campaignStatus), sentCount(organizationId, id)]);
    return {
      total,
      counts,
      sent,
      rows: rows.map(({ personId, firstName, lastName, title, phone, email, custom, mergeFields, companyName, companyDomain, linkedinUrl, raw, companyLinkedinUrl, companyRaw, slug, personName, profileUrl, accountName, resolveLastError, ...rest }) => {
        const own = sendsOf.get(rest.enrollmentId) ?? [];
        const latest = own[own.length - 1];
        const lastFailed = [...own].reverse().find((s) => s.error);
        return {
          ...rest,
          personId,
          inboxThreadId: inboxThreads.get(personId) ?? null,
          personName: personName ?? firstName,
          profileUrl: profileUrl ?? (slug ? profileUrlFor(slug) : null),
          variables: buildVariables({ firstName, lastName, fullName: personName, title, phone, email, companyName, companyDomain, linkedinUrl, raw, companyLinkedinUrl, companyRaw, custom, mergeFields }, labels),
          detail: {
            headline: title,
            companyName,
            accountName,
            sends: own.map((s) => ({ stepNumber: s.stepNumber as number, status: s.status, attempt: s.attempt, sentAt: s.sentAt, claimedAt: s.claimedAt, body: s.body, error: s.error })),
            retries: latest ? retriesUsed(latest.status, latest.attempt) : 0,
            lastError: lastFailed?.error ?? resolveLastError ?? null,
            alsoInCampaigns: cross.get(personId)?.alsoInCampaigns ?? [],
            excludedAccounts: cross.get(personId)?.excludedAccounts ?? [],
          },
        };
      }),
    };
  },

  async sampleVariables(organizationId, id) {
    const pick = async (enrolledIn: string | null) => {
      const query = db.select(personVariableColumns).from(people).leftJoin(companies, eq(companies.id, people.companyId));
      // The enrolled lead's own merge fields count, as they do when the step goes out.
      const rows = enrolledIn
        ? await db
            .select(enrollmentVariableColumns)
            .from(people)
            .leftJoin(companies, eq(companies.id, people.companyId))
            .innerJoin(campaignEnrollments, and(eq(campaignEnrollments.personId, people.id), eq(campaignEnrollments.campaignId, enrolledIn)))
            .where(and(eq(people.organizationId, organizationId), sql`${people.linkedinSlug} is not null`))
            .orderBy(asc(campaignEnrollments.createdAt))
            .limit(1)
        : await query
            .where(and(eq(people.organizationId, organizationId), sql`${people.linkedinSlug} is not null`))
            .orderBy(asc(people.createdAt))
            .limit(1);
      return rows[0];
    };
    const person = (await pick(id)) ?? (await pick(null));
    if (!person) return null;
    const columns = await db
      .select({ key: entityColumns.key, name: entityColumns.name })
      .from(entityColumns)
      .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people")));
    return buildVariables(person, new Map(columns.map((c) => [c.key, c.name])));
  },

  async accountLimits(organizationId, now) {
    const [settings] = await db
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "linkedin")));
    const rules = linkedinRules(settings?.values);
    const accounts = await db.select().from(linkedinAccounts).where(eq(linkedinAccounts.organizationId, organizationId)).orderBy(asc(linkedinAccounts.createdAt));
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    return Promise.all(
      accounts.map(async (account) => {
        const zone = (account.workingHours as WorkingHours | null)?.timeZone ?? "UTC";
        const [counts] = await db
          .select({
            today: sql<number>`(count(*) filter (where ${sends.claimedAt} >= ${startOfLocalDay(now, zone).toISOString()}::timestamptz))::int`,
            week: sql<number>`count(*)::int`,
          })
          .from(sends)
          .where(
            and(
              eq(sends.linkedinAccountId, account.id),
              eq(sends.stepNumber, 1),
              eq(sends.channel, "linkedin"),
              inArray(sends.status, SEND_COUNTED),
              sql`${sends.claimedAt} >= ${weekAgo}::timestamptz`,
            ),
          );
        return {
          id: account.id,
          name: account.name,
          username: account.username,
          status: account.status,
          dailyLimit: dailyInviteLimit(account, rules),
          invitesToday: counts.today,
          weeklyLimit: rules.invitesPerWeek,
          invitesThisWeek: counts.week,
          limitReachedUntil: account.limitReachedUntil && account.limitReachedUntil.getTime() > now.getTime() ? account.limitReachedUntil : null,
        };
      }),
    );
  },
};

/**
 * Enrolls the people a search found into its LinkedIn campaign, under the rule of every enroll path. Does nothing for a
 * completed or foreign campaign. Safe to repeat.
 */
export async function enrollFoundPeople(organizationId: string, campaignId: string, personIds: string[], handle?: DbHandle): Promise<{ added: number; skippedContact: number }> {
  if (personIds.length === 0) return { added: 0, skippedContact: 0 };
  return inTransaction(handle, async (tx) => {
    const [campaign] = await tx
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId), eq(campaigns.channel, "linkedin")));
    if (!campaign || campaign.status === "completed") return { added: 0, skippedContact: 0 };
    const { added, skippedContact } = await enrollPickedTx(tx, organizationId, campaignId, "linkedin", personIds, { viaTokenId: null });
    return { added, skippedContact };
  });
}
