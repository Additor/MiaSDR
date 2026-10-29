import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, conversations, messages, people, records, sends } from "@/platform/db/schema";
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
 * Membership in a campaign. "Any campaign" and "none" count regular campaigns only, like the list's Status column:
 * a personal campaign (`type = 'personal'`) is a private thread and never shows there. A named campaign matches its own id.
 */
const inCampaign = (campaignId: string | null) =>
  campaignId === null
    ? sql`exists (select 1 from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> ${REMOVED} and ${campaigns.type} = 'regular')`
    : sql`exists (select 1 from ${campaignEnrollments} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} <> ${REMOVED} and ${campaignEnrollments.campaignId} = ${campaignId}::uuid)`;

/**
 * The time of the lead's latest outreach that went out on any channel: the later of an outbound message (records,
 * conversations, messages) and a campaign step (`campaign_enrollments.last_sent_at`, regular campaigns only, removed
 * enrollments included), as one aggregate. Personal (private) threads stay out. Null when nothing was sent.
 * `readLeadStatuses` takes the same maximum for a page of leads (`latestContact` in `outreach/domain/lead-status.ts`).
 */
const lastSentAt = sql`select max(t.at) as at from (
  select ${messages.sentAt} as at from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} inner join ${messages} on ${messages.conversationId} = ${conversations.id} and ${messages.organizationId} = ${conversations.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation} and ${messages.direction} = 'outbound'
  union all
  select ${campaignEnrollments.lastSentAt} as at from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaigns.type} = 'regular'
) as t`;

/** An enrollment of the lead in a regular campaign has been stopped by a reply. */
const repliedEnrollment = sql`exists (select 1 from ${campaignEnrollments} inner join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId} and ${campaigns.organizationId} = ${campaignEnrollments.organizationId} where ${campaignEnrollments.personId} = ${people.id} and ${campaignEnrollments.organizationId} = ${people.organizationId} and ${campaignEnrollments.status} = ${REPLIED} and ${campaigns.type} = 'regular')`;

/** The person wrote at least one message in a public conversation (a personal campaign's private thread never counts). */
const inboundMessage = sql`exists (select 1 from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} inner join ${messages} on ${messages.conversationId} = ${conversations.id} and ${messages.organizationId} = ${conversations.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation} and ${messages.direction} = 'inbound')`;

/**
 * Replied: an enrollment has status `replied`, or the person has an inbound message in a public conversation. The lead
 * status (`readLeadStatuses` below) uses the same definition, so an unknown sender who wrote first shows Replied.
 */
const replied = sql`(${repliedEnrollment} or ${inboundMessage})`;

/** The person has a record with a public conversation, inbound or outbound. */
const hasPublicConversation = sql`exists (select 1 from ${records} inner join ${conversations} on ${conversations.recordId} = ${records.id} and ${conversations.organizationId} = ${records.organizationId} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${publicConversation})`;

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
  if (filter.hasConversation !== undefined) conditions.push(filter.hasConversation ? hasPublicConversation : sql`not ${hasPublicConversation}`);
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
      sql`exists (select 1 from ${records} where ${records.personId} = ${people.id} and ${records.organizationId} = ${people.organizationId} and ${records.groupKey} = ${filter.category})`,
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * The enrollments of these people in regular campaigns, with the campaign's name and status, newest first. The lead
 * status and the lead detail both read them here (`enrollments_person_idx`).
 */
function regularEnrollments(organizationId: string, personIds: readonly string[]) {
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
    .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, [...personIds]), eq(campaigns.type, "regular")))
    .orderBy(desc(campaignEnrollments.createdAt));
}

/**
 * The lead status of a page of person ids, keyed by person id. The lead list and the lead page both read it, so they
 * show the same state. Two reads, each one query for the whole page and each scoped to the organization: the enrollments
 * in regular campaigns with their campaign status, and the latest sent message and the inbound flag per lead. The last
 * contact is the later of that message and the enrollments' `last_sent_at`: campaign sends are stored in `sends` and
 * advance the enrollment, they write no message. Replied is an enrollment with status `replied` or an inbound message in a
 * public conversation, as in `activityCondition`. No query runs per lead.
 *
 * Index use: `enrollments_person_idx` for the enrollments; `records_person_reply_type_set_uq`, `conversations_record_idx` and
 * `messages_conversation_sent_idx` for the last contact. Personal (private) campaigns and their threads stay out, like
 * the Inbox leaves them out. A person with no enrollment and no message has no entry, and an id from another
 * organization finds nothing, so the caller falls back to `NEW_LEAD_STATUS`.
 */
export const readLeadStatuses: ReadLeadStatuses = async (organizationId, personIds) => {
  const result = new Map<string, LeadStatus>();
  if (personIds.length === 0) return result;
  const ids = [...new Set(personIds)];

  const [enrollmentRows, contactRows] = await Promise.all([
    regularEnrollments(organizationId, ids),
    db
      .select({
        personId: records.personId,
        lastContactAt: sql<Date | null>`max(${messages.sentAt}) filter (where ${messages.direction} = 'outbound')`,
        hasInbound: sql<boolean>`coalesce(bool_or(${messages.direction} = 'inbound'), false)`,
      })
      .from(records)
      .innerJoin(conversations, and(eq(conversations.recordId, records.id), eq(conversations.organizationId, records.organizationId)))
      .innerJoin(messages, and(eq(messages.conversationId, conversations.id), eq(messages.organizationId, conversations.organizationId)))
      .where(and(eq(records.organizationId, organizationId), inArray(records.personId, ids), publicConversation))
      .groupBy(records.personId),
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

/** Who reads sends: the actor, and whether they see every personal campaign (owner or admin). */
export interface SendViewer {
  userId: string;
  seesAllPersonal: boolean;
}

/**
 * A campaign the viewer may read sends of: a regular campaign, their own personal campaign, or any for an owner or admin.
 * Without a viewer, regular campaigns only.
 */
function visibleCampaign(viewer: SendViewer | undefined) {
  if (!viewer) return sql`${campaigns.type} = 'regular'`;
  if (viewer.seesAllPersonal) return sql`true`;
  return sql`(${campaigns.type} = 'regular' or coalesce(${campaigns.createdBy} = ${viewer.userId}, false))`;
}

/**
 * The outreach and conversations part of one lead's detail page, scoped to the organization: the enrollments in regular
 * campaigns, the campaign sends the viewer may see (newest claim first, at most 100), whether a personal campaign the
 * viewer may not see sent to the lead, and the newest public conversation for the Inbox link. People's own fields come
 * from the lead repository; `src/composition/leads.ts` joins the two.
 */
export async function readLeadDetailActivity(organizationId: string, personId: string, viewer: SendViewer | undefined) {
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

  const [enrollments, sendRows, [conversation], [hidden]] = await Promise.all([
    regularEnrollments(organizationId, [personId]),
    campaignSends().where(and(ofPerson, visibleCampaign(viewer))).orderBy(desc(sends.claimedAt)).limit(100),
    db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(records, and(eq(records.id, conversations.recordId), eq(records.organizationId, conversations.organizationId)))
      .where(and(eq(conversations.organizationId, organizationId), eq(records.personId, personId), publicConversation))
      .orderBy(desc(conversations.updatedAt))
      .limit(1),
    campaignSends().where(and(ofPerson, sql`not ${visibleCampaign(viewer)}`)).limit(1),
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
    conversationId: conversation?.id ?? null,
    // Campaign sends always carry a step number (sends_kind_shape_ck); test sends are filtered out above.
    sends: sendRows.map((r) => ({ ...r, stepNumber: r.stepNumber as number })),
    hiddenSends: hidden !== undefined,
  };
}
