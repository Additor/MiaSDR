import type { Actor } from "@/shared/errors";

/** A person of the report who has another enrollment that was contacted or answered. */
export interface AlreadyContactedNotice {
  personId: string;
  name: string | null;
  campaign: { id: string; name: string };
  channel: "email" | "linkedin";
  status: string;
}

/** A lead of this campaign that the claim skipped because its sending account already invited the person elsewhere. */
export interface ExcludedByAccountNotice {
  enrollmentId: string;
  personId: string;
  name: string | null;
  /** The account that invited the person before. */
  accountName: string | null;
  /** The campaign of that earlier invitation, when it is known. */
  campaign: { id: string; name: string } | null;
}

export interface CrossCampaignNotices {
  /** At most `NOTICE_LIST_LIMIT` rows. A person with several other campaigns appears once per campaign. */
  alreadyContacted: AlreadyContactedNotice[];
  /** People behind all rows, listed or not. */
  alreadyContactedPeople: number;
  excludedByAccount: ExcludedByAccountNotice[];
  excludedByAccountPeople: number;
}

/** What the row panel of one lead says about the rest of the organization. */
export interface LeadCrossContext {
  alsoInCampaigns: Array<{ campaignId: string; campaignName: string; channel: string; status: string }>;
  /** LinkedIn accounts that already sent this person an invitation, with the campaign it went out for. */
  excludedAccounts: Array<{ accountId: string; accountName: string | null; campaignName: string | null }>;
}

/** Read model. Never changes an enrollment, so suppression behaves as before. */
export interface CrossCampaignNoticeReader {
  /** Of `personIds`: those with another enrollment (other campaign) that sent a step or got a reply. */
  alreadyContacted(organizationId: string, campaignId: string, personIds: string[]): Promise<Pick<CrossCampaignNotices, "alreadyContacted" | "alreadyContactedPeople">>;
  /** Enrollments of the campaign skipped for `already_contacted_by_account`, narrowed to `personIds` when given. */
  excludedByAccount(organizationId: string, campaignId: string, personIds: string[] | null): Promise<Pick<CrossCampaignNotices, "excludedByAccount" | "excludedByAccountPeople">>;
  /** Per person of the page: other enrollments and the accounts that already invited them. */
  leadContext(organizationId: string, campaignId: string, personIds: string[]): Promise<Map<string, LeadCrossContext>>;
}

export const EMPTY_CROSS_CONTEXT: LeadCrossContext = { alsoInCampaigns: [], excludedAccounts: [] };

/** Notices for the people one enroll call handled. */
export async function noticesForPeople(reader: CrossCampaignNoticeReader, organizationId: string, campaignId: string, personIds: string[]): Promise<CrossCampaignNotices> {
  if (personIds.length === 0) return { alreadyContacted: [], alreadyContactedPeople: 0, excludedByAccount: [], excludedByAccountPeople: 0 };
  const [contacted, excluded] = await Promise.all([reader.alreadyContacted(organizationId, campaignId, personIds), reader.excludedByAccount(organizationId, campaignId, personIds)]);
  return { ...contacted, ...excluded };
}

/** The standing notice of a campaign: every lead the account rule skipped. */
export async function excludedNoticesForCampaign(reader: CrossCampaignNoticeReader, actor: Actor, campaignId: string) {
  return reader.excludedByAccount(actor.organizationId, campaignId, null);
}
