import type {
  CampaignCounts,
  ChannelCounts,
  DailyEventRow,
  LinkedInAccountCounts,
  LinkedInCampaignFunnel,
  LinkedInEventCounts,
  ReplyCountRow,
  SenderCounts,
  SuppressionReason,
} from "../domain/metrics";
import type { Channel } from "../domain/metrics";

/** Every query gets the organization, the window (local days in `timeZone`) and the optional filters. */
export interface AnalyticsFilter {
  organizationId: string;
  from: string;
  to: string;
  timeZone: string;
  campaignId: string | null;
  /** Archived campaigns count unless this is true. */
  excludeArchived: boolean;
  /** LinkedIn view only. */
  linkedinAccountId: string | null;
}

export interface FilterOptions {
  campaigns: Array<{ id: string; name: string; channel: Channel; archived: boolean }>;
  linkedinAccounts: Array<{ id: string; name: string }>;
}

/** Read-only. Implementations count rows exactly as `domain/metrics.ts` defines each metric. */
export interface AnalyticsReadModel {
  /** The organization's IANA zone, or null when none is set. */
  timeZone(organizationId: string): Promise<string | null>;
  filterOptions(organizationId: string): Promise<FilterOptions>;
  campaigns(filter: AnalyticsFilter): Promise<CampaignCounts[]>;
  channels(filter: AnalyticsFilter): Promise<{ channels: ChannelCounts[]; senders: SenderCounts[] }>;
  linkedin(filter: AnalyticsFilter): Promise<{ campaigns: LinkedInCampaignFunnel[]; events: LinkedInEventCounts; accounts: LinkedInAccountCounts[] }>;
  replies(filter: AnalyticsFilter): Promise<{ rows: ReplyCountRow[]; suppressions: Partial<Record<SuppressionReason, number>> }>;
  daily(filter: AnalyticsFilter): Promise<DailyEventRow[]>;
}
