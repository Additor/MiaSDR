import { and, eq, inArray, sql } from "drizzle-orm";
import { publicConversation } from "@/platform/db/conversation-visibility";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, conversations, messages, records } from "@/platform/db/schema";
import { leadStatus, type LeadEnrollmentFact, type LeadStatus, type ReadLeadStatuses } from "../domain/lead-status";

/**
 * The lead status of a page of person ids, keyed by person id. The lead list and the lead page both read it, so they
 * show the same state. Two reads, each one query for the whole page and each scoped to the organization: the enrollments
 * in regular campaigns with their campaign status, and the latest sent message and the inbound flag per lead. The last
 * contact is the later of that message and the enrollments' `last_sent_at`: campaign sends are stored in `sends` and
 * advance the enrollment, they write no message. Replied is an enrollment with status `replied` or an inbound message in a
 * public conversation (the `replied` filter in the people context uses the same definition). No query runs per lead.
 *
 * Index use: `enrollments_person_idx` for the enrollments; `records_person_pipeline_uq`, `conversations_record_idx` and
 * `messages_conversation_sent_idx` for the last contact. Personal (private) campaigns and their threads stay out, like
 * the Inbox leaves them out. A person with no enrollment and no message has no entry, and an id from another
 * organization finds nothing, so the caller falls back to `NEW_LEAD_STATUS`.
 */
export const readLeadStatuses: ReadLeadStatuses = async (organizationId, personIds) => {
  const result = new Map<string, LeadStatus>();
  if (personIds.length === 0) return result;
  const ids = [...new Set(personIds)];

  const [enrollmentRows, contactRows] = await Promise.all([
    db
      .select({
        id: campaignEnrollments.id,
        personId: campaignEnrollments.personId,
        status: campaignEnrollments.status,
        updatedAt: campaignEnrollments.updatedAt,
        lastSentAt: campaignEnrollments.lastSentAt,
        nextSendAt: campaignEnrollments.nextSendAt,
        currentStep: campaignEnrollments.currentStep,
        stopReason: campaignEnrollments.stopReason,
        campaignName: campaigns.name,
        campaignStatus: campaigns.status,
      })
      .from(campaignEnrollments)
      .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), inArray(campaignEnrollments.personId, ids), eq(campaigns.type, "regular"))),
    db
      .select({
        personId: records.personId,
        lastContactAt: sql<Date | null>`max(${messages.sentAt}) filter (where ${messages.direction} = 'outbound')`,
        hasInbound: sql<boolean>`coalesce(bool_or(${messages.direction} = 'inbound'), false)`,
      })
      .from(records)
      .innerJoin(conversations, and(eq(conversations.recordId, records.id), eq(conversations.organizationId, records.organizationId)))
      .innerJoin(messages, and(eq(messages.conversationId, conversations.id), eq(messages.organizationId, conversations.organizationId)))
      .where(
        and(
          eq(records.organizationId, organizationId),
          inArray(records.personId, ids),
          publicConversation,
        ),
      )
      .groupBy(records.personId),
  ]);

  const facts = new Map<string, LeadEnrollmentFact[]>();
  for (const { personId, ...row } of enrollmentRows) {
    const list = facts.get(personId) ?? [];
    list.push(row);
    facts.set(personId, list);
  }
  const lastContact = new Map(contactRows.flatMap((row) => (row.lastContactAt ? [[row.personId, new Date(row.lastContactAt)] as const] : [])));
  const inbound = new Set(contactRows.filter((row) => row.hasInbound).map((row) => row.personId));

  for (const id of new Set([...facts.keys(), ...lastContact.keys(), ...inbound])) {
    result.set(id, leadStatus({ enrollments: facts.get(id) ?? [], lastOutboundAt: lastContact.get(id) ?? null, hasInbound: inbound.has(id) }));
  }
  return result;
};
