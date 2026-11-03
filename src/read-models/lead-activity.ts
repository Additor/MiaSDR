import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { genuineInboundSql } from "@/platform/db/genuine-inbound";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, threads, messages, people, conversations, sends } from "@/platform/db/schema";
import type { EnrollmentStatus } from "@/contexts/outreach/domain/enrollment-status";
import { leadStatus, type LeadEnrollmentFact, type LeadStatus, type ReadLeadStatuses } from "@/contexts/outreach/domain/lead-status";
import type { LeadFilter } from "@/contexts/people/domain/lead-filter";

/*
 * Lead activity: what a lead did across outreach and conversations, as the lead screens filter and show it ("Read models"
 * in docs/decisions.md). The filter conditions and the lead status read share one definition of each fact, so a lead the
 * list finds under a filter shows the matching status, and the bulk actions, the export and previous/next see the
 * list's set.
 */

const REMOVED = "removed" satisfies EnrollmentStatus;
const REPLIED = "replied" satisfies EnrollmentStatus;

/**
 * Membership in a campaign. `null` matches any campaign; a named campaign matches its own id.
 */
const inCampaign = (campaignId: string | null) =>
  campaignId === null
    ? sql`exists (select 1 from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> ${REMOVED})`
    : sql`exists (select 1 from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> ${REMOVED} and ${campaignEnrollments.campaignId} = ${campaignId}::uuid)`;

/**
 * The time of the lead's latest outreach that went out on any channel: the later of an outbound message (conversations,
 * conversations, messages) and a campaign step (`campaign_enrollments.last_sent_at`, removed enrollments included), as one
 * aggregate. Null when nothing was sent.
 * `readLeadStatuses` takes the same maximum for a page of leads (`latestContact` in `outreach/domain/lead-status.ts`).
 */
const lastSentAt = sql`select max(t.at) as at from (
  select ${messages.sentAt} as at from ${conversations} inner join ${threads} on ${threads.conversationId} = ${conversations.id} and ${threads.organizationId} = ${conversations.organizationId} inner join ${messages} on ${messages.threadId} = ${threads.id} and ${messages.organizationId} = ${threads.organizationId} where ${conversations.personId} = ${people.id} and ${conversations.organizationId} = ${people.organizationId} and ${messages.direction} = 'outbound'
  union all
  select ${campaignEnrollments.lastSentAt} as at from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId}
) as t`;

/** An enrollment of the lead has been stopped by a reply. */
const repliedEnrollment = sql`exists (select 1 from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} = ${REPLIED})`;

/** The person wrote at least one genuine message. */
const inboundMessage = sql`exists (select 1 from ${conversations} inner join ${threads} on ${threads.conversationId} = ${conversations.id} and ${threads.organizationId} = ${conversations.organizationId} inner join ${messages} on ${messages.threadId} = ${threads.id} and ${messages.organizationId} = ${threads.organizationId} where ${conversations.personId} = ${people.id} and ${conversations.organizationId} = ${people.organizationId} and ${genuineInboundSql("messages")})`;

/**
 * Replied: an enrollment has status `replied`, or the person has a genuine inbound message. The lead
 * status (`readLeadStatuses` below) uses the same definition, so an unknown sender who wrote first shows Replied.
 */
const replied = sql`(${repliedEnrollment} or ${inboundMessage})`;

/** The person has a conversation with a conversation, inbound or outbound. */
const hasAnyConversation = sql`exists (select 1 from ${conversations} inner join ${threads} on ${threads.conversationId} = ${conversations.id} and ${threads.organizationId} = ${conversations.organizationId} where ${conversations.personId} = ${people.id} and ${conversations.organizationId} = ${people.organizationId})`;

/**
 * The conditions of the lead filter on outreach and conversations tables: campaign membership, Replied, conversation,
 * last contact and CRM category. The people context adds its own conditions on `people` and `companies`, and
 * `src/composition/leads.ts` hands this function to the lead list, the repository and the neighbor read.
 */
export function activityCondition(filter: LeadFilter): SQL | undefined {
  const conditions: Array<SQL | undefined> = [];
  if (filter.campaign === "any") conditions.push(inCampaign(null));
  else if (filter.campaign === "none") conditions.push(sql`not ${inCampaign(null)}`);
  else if (filter.campaign) conditions.push(inCampaign(filter.campaign));
  if (filter.notInCampaign) conditions.push(sql`not ${inCampaign(filter.notInCampaign)}`);
  if (filter.replied !== undefined) conditions.push(filter.replied ? replied : sql`not ${replied}`);
  if (filter.hasConversation !== undefined) conditions.push(filter.hasConversation ? hasAnyConversation : sql`not ${hasAnyConversation}`);
  // The aggregate is a single-row derived table, so the joins run once per lead whichever bounds are set. A lead never
  // contacted has a null maximum, and a null fails both comparisons.
  if (filter.lastContactFrom || filter.lastContactTo) {
    const bounds: SQL[] = [];
    if (filter.lastContactFrom) bounds.push(sql`last_contact.at >= ${filter.lastContactFrom}::date::timestamp at time zone 'UTC'`);
    if (filter.lastContactTo) bounds.push(sql`last_contact.at < (${filter.lastContactTo}::date + 1)::timestamp at time zone 'UTC'`);
    conditions.push(sql`exists (select 1 from (${lastSentAt}) as last_contact where ${sql.join(bounds, sql` and `)})`);
  }
  if (filter.category) {
    conditions.push(
      sql`exists (select 1 from ${conversations} where ${conversations.personId} = ${people.id} and ${conversations.organizationId} = ${people.organizationId} and ${conversations.groupKey} = ${filter.category})`,
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * The enrollments of these people, with the campaign's name and status, newest first. The lead
 * status and the lead detail both read them here (`enrollments_person_idx`).
 */
function enrollmentsOfPeople(organizationId: string, personIds: readonly string[]) {
  return db
    .select({
      id: campaignEnrollments.id,
      personId: campaignEnrollments.personId,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      campaignStatus: campaigns.status,
      channel: campaignEnrollments.channel,
      status: campaignEnrollments.status,
      updatedAt: campaignEnrollments.updatedAt,
      lastSentAt: campaignEnrollments.lastSentAt,
      nextSendAt: campaignEnrollments.nextSendAt,
      currentStep: campaignEnrollments.currentStep,
      stopReason: campaignEnrollments.stopReason,
    })
    .from(campaignEnrollments)
    .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
    .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, [...personIds])))
    .orderBy(desc(campaignEnrollments.createdAt));
}

/**
 * The lead status of a page of person ids, keyed by person id. The lead list and the lead page both read it, so they
 * show the same state. Two reads, each one query for the whole page and each scoped to the organization: the enrollments
 * with their campaign status, and the latest sent message and the inbound flag per lead. The last
 * contact is the later of that message and the enrollments' `last_sent_at`: campaign sends are stored in `sends` and
 * advance the enrollment, they write no message. Replied is an enrollment with status `replied` or an inbound message, as in `activityCondition`. No query runs per lead.
 *
 * Index use: `enrollments_person_idx` for the enrollments; `conversations_person_reply_type_set_uq`, `threads_conversation_idx` and
 * `messages_thread_sent_idx` for the last contact. A person with no enrollment and no message has no entry, and an id from another
 * organization finds nothing, so the caller falls back to `NEW_LEAD_STATUS`.
 */
export const readLeadStatuses: ReadLeadStatuses = async (organizationId, personIds) => {
  const result = new Map<string, LeadStatus>();
  if (personIds.length === 0) return result;
  const ids = [...new Set(personIds)];

  const [enrollmentRows, contactRows] = await Promise.all([
    enrollmentsOfPeople(organizationId, ids),
    db
      .select({
        personId: conversations.personId,
        lastContactAt: sql<Date | null>`max(${messages.sentAt}) filter (where ${messages.direction} = 'outbound')`,
        hasInbound: sql<boolean>`coalesce(bool_or(${genuineInboundSql("messages")}), false)`,
      })
      .from(conversations)
      .innerJoin(threads, and(eq(threads.conversationId, conversations.id), eq(threads.organizationId, conversations.organizationId)))
      .innerJoin(messages, and(eq(messages.threadId, threads.id), eq(messages.organizationId, threads.organizationId)))
      .where(and(eq(conversations.organizationId, organizationId), inArray(conversations.personId, ids)))
      .groupBy(conversations.personId),
  ]);

  const facts = new Map<string, LeadEnrollmentFact[]>();
  for (const row of enrollmentRows) {
    const list = facts.get(row.personId) ?? [];
    list.push({
      id: row.id,
      status: row.status,
      campaignStatus: row.campaignStatus,
      campaignName: row.campaignName,
      updatedAt: row.updatedAt,
      lastSentAt: row.lastSentAt,
      nextSendAt: row.nextSendAt,
      currentStep: row.currentStep,
      stopReason: row.stopReason,
    });
    facts.set(row.personId, list);
  }
  const lastContact = new Map(contactRows.flatMap((row) => (row.lastContactAt ? [[row.personId, new Date(row.lastContactAt)] as const] : [])));
  const inbound = new Set(contactRows.filter((row) => row.hasInbound).map((row) => row.personId));

  for (const id of new Set([...facts.keys(), ...lastContact.keys(), ...inbound])) {
    result.set(id, leadStatus({ enrollments: facts.get(id) ?? [], lastOutboundAt: lastContact.get(id) ?? null, hasInbound: inbound.has(id) }));
  }
  return result;
};

/**
 * The outreach and conversations part of one lead's detail page, scoped to the organization: the enrollments, the campaign
 * sends (newest claim first, at most 100), and the newest conversation for the Inbox link. People's own fields come
 * from the lead repository; `src/composition/leads.ts` joins the two.
 */
export async function readLeadDetailActivity(organizationId: string, personId: string) {
  const campaignSends = () =>
    db
      .select({
        id: sends.id,
        campaignId: campaigns.id,
        campaignName: campaigns.name,
        stepNumber: sends.stepNumber,
        channel: sends.channel,
        status: sends.status,
        subject: sends.subject,
        sentAt: sends.sentAt,
        claimedAt: sends.claimedAt,
        error: sends.error,
      })
      .from(sends)
      .innerJoin(campaignEnrollments, and(eq(campaignEnrollments.id, sends.enrollmentId), eq(campaignEnrollments.organizationId, sends.organizationId)))
      .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)));
  const ofPerson = and(eq(sends.organizationId, organizationId), eq(sends.kind, "campaign"), eq(campaignEnrollments.personId, personId));

  const [enrollments, sendRows, [thread]] = await Promise.all([
    enrollmentsOfPeople(organizationId, [personId]),
    campaignSends().where(ofPerson).orderBy(desc(sends.claimedAt)).limit(100),
    db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(conversations, and(eq(conversations.id, threads.conversationId), eq(conversations.organizationId, threads.organizationId)))
      .where(and(eq(threads.organizationId, organizationId), eq(conversations.personId, personId)))
      .orderBy(desc(threads.updatedAt))
      .limit(1),
  ]);

  return {
    enrollments: enrollments.map((e) => ({
      id: e.id,
      campaignId: e.campaignId,
      campaignName: e.campaignName,
      campaignStatus: e.campaignStatus,
      channel: e.channel,
      status: e.status,
      currentStep: e.currentStep,
      nextSendAt: e.nextSendAt,
      lastSentAt: e.lastSentAt,
      stopReason: e.stopReason,
    })),
    threadId: thread?.id ?? null,
    // Campaign sends always carry a step number (sends_kind_shape_ck); test sends are filtered out above.
    sends: sendRows.map((r) => ({ ...r, stepNumber: r.stepNumber as number })),
  };
}
