import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaignEnrollments, campaigns, conversations, messages, people, records } from "@/platform/db/schema";
import type { PersonalThreadStore } from "../application/personal-thread";
import { parseCampaignType } from "../../domain/campaign";

/**
 * The one reader of private conversations. It skips the Inbox visibility rule on purpose and selects only the conversations
 * marked with this campaign, so a thread of another personal campaign never leaks through it.
 */
export const drizzlePersonalThreadStore: PersonalThreadStore = {
  async campaign(organizationId, id) {
    const [row] = await db
      .select({ id: campaigns.id, name: campaigns.name, type: campaigns.type, createdBy: campaigns.createdBy })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, id), eq(campaigns.channel, "linkedin")));
    return row ? { ...row, type: parseCampaignType(row.type) } : null;
  },

  async thread(organizationId, campaignId, enrollmentId) {
    const [lead] = await db
      .select({ personId: campaignEnrollments.personId, fullName: people.fullName, firstName: people.firstName })
      .from(campaignEnrollments)
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.campaignId, campaignId), eq(campaignEnrollments.id, enrollmentId)));
    if (!lead) return null;
    const rows = await db
      .select({ id: messages.id, direction: messages.direction, at: messages.sentAt, text: messages.bodyText })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(records, eq(records.id, conversations.recordId))
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.privateCampaignId, campaignId),
          eq(conversations.channel, "linkedin"),
          eq(records.personId, lead.personId),
        ),
      )
      .orderBy(asc(messages.sentAt), asc(messages.id));
    return { personName: lead.fullName ?? lead.firstName, messages: rows.map((r) => ({ ...r, direction: r.direction as "inbound" | "outbound" })) };
  },
};

/** The people of this personal campaign who have a private conversation stored under it, whatever their enrollment status now is. */
export async function peopleWithPrivateThread(organizationId: string, campaignId: string, personIds: string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ personId: records.personId })
    .from(conversations)
    .innerJoin(records, eq(records.id, conversations.recordId))
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.privateCampaignId, campaignId), inArray(records.personId, personIds)));
  return new Set(rows.map((r) => r.personId));
}
