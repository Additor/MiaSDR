import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { leadSearchCondition } from "@/contexts/people/infrastructure/queries";
import { db, inTransaction, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaigns, channelSettings, companies, conversations, entityColumns, linkedinAccounts, linkedinEnrollmentDetails, people, sends } from "@/platform/db/schema";
import { ConflictError } from "@/shared/errors";
import type { LinkedInCampaignStore, LinkedInEnrollResult } from "../application/linkedin-campaigns";
import { drizzleCrossCampaignNotices } from "../../infrastructure/drizzle-cross-campaign-notices";
import { peopleWithPrivateThread } from "./drizzle-personal-thread-store";
import { insertSkippingContacts, notContactSql } from "../../infrastructure/contact-guard";
import { archiveCondition, checkedStatusChange, stepsStillEditable } from "../../infrastructure/drizzle-management-stores";
import { parseCampaignType, type CampaignStatus } from "../../domain/campaign";
import { retriesUsed } from "../../domain/enrollment-list";
import { filteredScope, sentCount, tabCounts } from "../../infrastructure/enrollment-list-sql";
import { inboxConversationsOfPeople } from "../../infrastructure/inbox-thread-lookup";
import { dailyInviteLimit, linkedinRules, profileUrlFor, type LinkedInStep } from "../domain/linkedin";
import { parseMemberUrl } from "../domain/linkedin-identity";
import { buildVariables } from "../../domain/variables";
import { enrollmentVariableColumns, personVariableColumns } from "../../infrastructure/enrollment-variables";
import { startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { doNotContactSql } from "@/contexts/people/infrastructure/reachability";
import { SEND_COUNTED } from "../../domain/send-status";

const DAY_MS = 86_400_000;

/** Sales Navigator and Recruiter member URLs, same shapes as `parseMemberUrl`: a known path prefix and an id of 10 or more safe characters. */
const MEMBER_URL_SQL =
  "^(https?://)?([a-z0-9-]+\\.)*linkedin\\.com/(sales/(lead|people)/|talent/(profile/|hire/[^/]+/profile/))[A-Za-z0-9_-]{10,}([,?/#]|%2c|$)";

/**
 * A person a LinkedIn campaign can enroll: a public slug, a Sales Navigator or Recruiter URL, or a stored member id.
 * One fragment for the query form, the personIds form and the counts, so they cannot disagree.
 */
const hasProfile = sql`(${people.linkedinSlug} is not null or coalesce(${people.linkedinUrl} ~* ${MEMBER_URL_SQL}, false) or ${people.raw}->>'linkedin_member_id' is not null)`;

type EnrollCandidate = { id: string; slug: string | null; url: string | null; memberId: string | null };

/** The identifier a resolve starts from: the profile URL of the slug, else the stored member URL as typed, else the bare member id. */
function enrollmentProfileUrl(p: EnrollCandidate): string | null {
  if (p.slug) return profileUrlFor(p.slug);
  if (p.url && parseMemberUrl(p.url)) return p.url;
  return p.memberId;
}

async function insertEnrollments(tx: DbHandle, organizationId: string, campaignId: string, eligible: EnrollCandidate[]): Promise<{ addedPersonIds: string[]; skippedContact: number }> {
  const urlOf = new Map(
    eligible.flatMap((p) => {
      const profileUrl = enrollmentProfileUrl(p);
      return profileUrl ? [[p.id, profileUrl] as const] : [];
    }),
  );
  const ids = [...urlOf.keys()].sort();
  const addedPersonIds: string[] = [];
  let skippedContact = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const result = await insertSkippingContacts(tx, organizationId, ids.slice(i, i + 500), (sp, keep) =>
      sp
        .insert(campaignEnrollments)
        .values(keep.map((personId) => ({ organizationId, campaignId, personId, channel: "linkedin" })))
        .onConflictDoNothing()
        .returning({ id: campaignEnrollments.id, personId: campaignEnrollments.personId }),
    );
    const { inserted } = result;
    if (inserted.length > 0) {
      await tx
        .insert(linkedinEnrollmentDetails)
        .values(inserted.map((e) => ({ enrollmentId: e.id, organizationId, profileUrl: urlOf.get(e.personId) as string })))
        .onConflictDoNothing();
    }
    addedPersonIds.push(...inserted.map((e) => e.personId));
    skippedContact += result.skippedContact;
  }
  return { addedPersonIds, skippedContact };
}

export const drizzleLinkedInCampaignStore: LinkedInCampaignStore = {
  transaction: (fn, within) => inTransaction(within, fn),

  async list(organizationId, archived = "hide") {
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        type: campaigns.type,
        status: campaigns.status,
        steps: campaigns.steps,
        archivedAt: campaigns.archivedAt,
        createdAt: campaigns.createdAt,
        createdBy: campaigns.createdBy,
        enrolled: sql<number>`count(${campaignEnrollments.id})::int`,
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
    return rows.map((r) => ({ ...r, type: parseCampaignType(r.type), status: r.status as CampaignStatus, steps: r.steps as unknown as LinkedInStep[] }));
  },

  async get(organizationId, id, tx) {
    const [row] = await (tx ?? db)
      .select({ id: campaigns.id, name: campaigns.name, type: campaigns.type, status: campaigns.status, steps: campaigns.steps, archivedAt: campaigns.archivedAt, createdAt: campaigns.createdAt, createdBy: campaigns.createdBy })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "linkedin")));
    return row ? { ...row, type: parseCampaignType(row.type), status: row.status as CampaignStatus, steps: row.steps as unknown as LinkedInStep[] } : null;
  },

  async create(organizationId, input, tx) {
    const [row] = await (tx ?? db)
      .insert(campaigns)
      .values({ organizationId, channel: "linkedin", name: input.name, type: input.type ?? "regular", status: "draft", steps: input.steps as never, createdBy: input.createdBy })
      .returning({ id: campaigns.id });
    return row.id;
  },

  async furthestStep(organizationId, id) {
    const [row] = await db
      .select({ furthest: sql<number>`coalesce(max(${campaignEnrollments.currentStep}), 0)::int` })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, id)));
    return row.furthest;
  },

  async hasSends(organizationId, id) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .where(and(eq(sends.organizationId, organizationId), eq(campaignEnrollments.campaignId, id)));
    return row.n > 0;
  },

  async update(organizationId, id, patch, handle) {
    const set = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.type !== undefined ? { type: patch.type } : {}), ...(patch.steps !== undefined ? { steps: patch.steps as never } : {}) };
    // An empty patch changes nothing. Drizzle throws "No values to set" for an empty SET, which would answer 500.
    if (Object.keys(set).length === 0) return true;
    return inTransaction(handle, async (tx) => {
      if (patch.type !== undefined) {
        // The type guard runs under the campaign row lock. The LinkedIn claim takes the same row `for share` before it inserts a send,
        // so a claim in flight either committed (this check sees its send) or waits for this commit.
        const [row] = await tx
          .select({ type: campaigns.type })
          .from(campaigns)
          .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id)))
          .for("update");
        if (row && row.type !== patch.type) {
          const [sent] = await tx
            .select({ one: sql<number>`1` })
            .from(sends)
            .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
            .where(and(eq(sends.organizationId, organizationId), eq(campaignEnrollments.campaignId, id)))
            .limit(1);
          if (sent) throw new ConflictError("The campaign type cannot change once the campaign has sent something.");
          if (row.type === "personal") {
            const [kept] = await tx
              .select({ one: sql<number>`1` })
              .from(conversations)
              .where(and(eq(conversations.organizationId, organizationId), eq(conversations.privateCampaignId, id)))
              .limit(1);
            if (kept) throw new ConflictError("This campaign already holds private replies, so it stays personal.");
          }
        }
      }
      const rows = await tx
        .update(campaigns)
        .set(set)
        .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), stepsStillEditable(patch)))
        .returning({ id: campaigns.id });
      return rows.length > 0;
    });
  },

  async setStatus(organizationId, id, change) {
    const rows = await db.update(campaigns).set({ status: change.to }).where(checkedStatusChange(organizationId, id, change)).returning({ id: campaigns.id });
    return rows.length > 0;
  },

  async delete(organizationId, id) {
    try {
      await db.delete(campaigns).where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.status, "draft")));
    } catch (error) {
      // conversations_private_campaign_fk: replies of a personal campaign are stored under it and keep it alive.
      const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      const constraint = (error as { constraint_name?: string; constraint?: string }).constraint_name ?? (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
      if (code === "23503" && constraint === "conversations_private_campaign_fk") {
        throw new ConflictError("This campaign holds private replies and cannot be deleted. Archive it instead.");
      }
      throw error;
    }
  },

  async setArchived(organizationId, id, archived) {
    const rows = await db
      .update(campaigns)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "linkedin"), archived ? eq(campaigns.status, "completed") : undefined))
      .returning({ id: campaigns.id });
    return rows.length > 0;
  },

  async enroll(organizationId, id, filter, handle): Promise<LinkedInEnrollResult> {
    const matching = and(eq(people.organizationId, organizationId), leadSearchCondition(filter.query));
    return inTransaction(handle, async (tx) => {
      const dnc = doNotContactSql("people");
      const already = sql`exists (select 1 from campaign_enrollments e where e.campaign_id = ${id} and e.person_id = ${people.id})`;

      const [skipped] = await tx
        .select({
          matched: sql<number>`count(*)::int`,
          noProfile: sql<number>`(count(*) filter (where not ${hasProfile}))::int`,
          dnc: sql<number>`(count(*) filter (where ${hasProfile} and ${dnc}))::int`,
          already: sql<number>`(count(*) filter (where ${hasProfile} and ${already}))::int`,
          contact: sql<number>`(count(*) filter (where ${hasProfile} and not ${already} and not ${dnc} and not ${notContactSql}))::int`,
        })
        .from(people)
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(matching);

      const eligibleWhere = and(matching, hasProfile, sql`not ${dnc}`, sql`not ${already}`, notContactSql);
      if (filter.dryRun) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(people)
          .leftJoin(companies, eq(companies.id, people.companyId))
          .where(eligibleWhere);
        return {
          requested: skipped.matched,
          skippedMissingIdentity: skipped.noProfile,
          skippedDuplicate: skipped.already,
          skippedSuppressed: 0,
          added: 0,
          alreadyEnrolled: skipped.already,
          skippedNoProfile: skipped.noProfile,
          skippedDoNotContact: skipped.dnc,
          skippedContact: skipped.contact,
          wouldAdd: Math.min(n, filter.limit),
        };
      }

      const eligible = await tx
        .select({ id: people.id, slug: people.linkedinSlug, url: people.linkedinUrl, memberId: sql<string | null>`${people.raw}->>'linkedin_member_id'` })
        .from(people)
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(eligibleWhere)
        .orderBy(asc(people.createdAt), asc(people.id))
        .limit(filter.limit);

      const { addedPersonIds, skippedContact } = await insertEnrollments(tx, organizationId, id, eligible);
      const added = addedPersonIds.length;
      return {
        ...(filter.collectIds ? { addedPersonIds } : {}),
        requested: skipped.matched,
        skippedMissingIdentity: skipped.noProfile,
        skippedDuplicate: skipped.already,
        skippedSuppressed: 0,
        added,
        alreadyEnrolled: skipped.already,
        skippedNoProfile: skipped.noProfile,
        skippedDoNotContact: skipped.dnc,
        skippedContact: skipped.contact + skippedContact,
      };
    });
  },

  async countConnectedAccounts(organizationId) {
    const rows = await db
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
    const withThread = await peopleWithPrivateThread(organizationId, id, [...new Set(rows.map((r) => r.personId))]);
    const repliedPeople = [...new Set(rows.filter((r) => r.status === "replied").map((r) => r.personId))];
    const inboxThreads = await inboxConversationsOfPeople(organizationId, "linkedin", repliedPeople);
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
          inboxConversationId: inboxThreads.get(personId) ?? null,
          hasPrivateThread: withThread.has(personId),
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
 * Enrolls specific people (found by a search) into a LinkedIn campaign. Skips people without a profile slug, member URL or member id, with
 * do-not-contact, contacts, or already enrolled, and does nothing for a completed or foreign campaign. Safe to repeat.
 */
export async function enrollPeopleCounted(organizationId: string, campaignId: string, personIds: string[], handle?: DbHandle): Promise<{ added: number; skippedContact: number }> {
  if (personIds.length === 0) return { added: 0, skippedContact: 0 };
  return inTransaction(handle, async (tx) => {
    const [campaign] = await tx
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId), eq(campaigns.channel, "linkedin")));
    if (!campaign || campaign.status === "completed") return { added: 0, skippedContact: 0 };

    const dnc = doNotContactSql("people");
    const picked = and(eq(people.organizationId, organizationId), inArray(people.id, personIds), hasProfile, sql`not ${dnc}`);
    const eligible = await tx
      .select({ id: people.id, slug: people.linkedinSlug, url: people.linkedinUrl, memberId: sql<string | null>`${people.raw}->>'linkedin_member_id'` })
      .from(people)
      .where(and(picked, notContactSql));

    const { addedPersonIds } = await insertEnrollments(tx, organizationId, campaignId, eligible);
    // Counted after the insert, so a person who became a contact meanwhile (dropped by the savepoint) is in the count too.
    const [{ contacts }] = await tx
      .select({ contacts: sql<number>`count(*)::int` })
      .from(people)
      .where(and(picked, sql`not ${notContactSql}`));
    return { added: addedPersonIds.length, skippedContact: contacts };
  });
}

export async function enrollPeople(organizationId: string, campaignId: string, personIds: string[], handle?: DbHandle): Promise<number> {
  return (await enrollPeopleCounted(organizationId, campaignId, personIds, handle)).added;
}
