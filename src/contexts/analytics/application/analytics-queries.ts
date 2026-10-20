import { canonicalTimeZone } from "@/shared/time-zone";
import { localDay } from "@/platform/jobs/local-day";
import { ValidationError, type Actor } from "@/shared/errors";
import { eachDay, parseOptionalId, resolveRange, AnalyticsInputError, type DateRange } from "../domain/range";
import {
  campaignsReport,
  channelsReport,
  linkedinReport,
  repliesReport,
  timeSeriesReport,
  type CampaignsReport,
  type ChannelsReport,
  type LinkedInReport,
  type RepliesReport,
  type TimeSeriesReport,
} from "../domain/metrics";
import type { AnalyticsFilter, AnalyticsReadModel, FilterOptions } from "./ports";

export const ANALYTICS_VIEWS = ["campaigns", "channels", "linkedin", "replies", "timeseries"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export const isAnalyticsView = (value: string): value is AnalyticsView => (ANALYTICS_VIEWS as readonly string[]).includes(value);

export interface AnalyticsDeps {
  readModel: AnalyticsReadModel;
  /** Defaults to the system clock. */
  now?: () => Date;
}

export interface AnalyticsRequest {
  from?: string | null;
  to?: string | null;
  campaignId?: string | null;
  linkedinAccountId?: string | null;
  /** Leave archived campaigns out of every number. Default false: they count. */
  excludeArchived?: boolean | null;
}

export interface AnalyticsScope {
  range: DateRange;
  timeZone: string;
  campaignId: string | null;
  linkedinAccountId: string | null;
  excludeArchived: boolean;
}

export type AnalyticsReport =
  | { view: "campaigns"; data: CampaignsReport }
  | { view: "channels"; data: ChannelsReport }
  | { view: "linkedin"; data: LinkedInReport }
  | { view: "replies"; data: RepliesReport }
  | { view: "timeseries"; data: TimeSeriesReport };

export type AnalyticsResult = AnalyticsReport & { scope: AnalyticsScope };

/** Any member of the organization can read analytics. Every query filters by the actor's organization. */
async function prepare(deps: AnalyticsDeps, actor: Actor, request: AnalyticsRequest): Promise<{ filter: AnalyticsFilter; scope: AnalyticsScope }> {
  try {
    const stored = await deps.readModel.timeZone(actor.organizationId);
    const timeZone = (stored ? canonicalTimeZone(stored) : null) ?? "UTC";
    const range = resolveRange(request, localDay(deps.now?.() ?? new Date(), timeZone));
    const campaignId = parseOptionalId(request.campaignId, "The campaign");
    const linkedinAccountId = parseOptionalId(request.linkedinAccountId, "The LinkedIn account");
    const excludeArchived = request.excludeArchived === true;
    return {
      filter: { organizationId: actor.organizationId, from: range.from, to: range.to, timeZone, campaignId, linkedinAccountId, excludeArchived },
      scope: { range, timeZone, campaignId, linkedinAccountId, excludeArchived },
    };
  } catch (error) {
    if (error instanceof AnalyticsInputError) throw new ValidationError(error.message);
    throw error;
  }
}

export async function getAnalytics(deps: AnalyticsDeps, actor: Actor, view: AnalyticsView, request: AnalyticsRequest): Promise<AnalyticsResult> {
  const { filter, scope } = await prepare(deps, actor, request);
  const rm = deps.readModel;
  switch (view) {
    case "campaigns":
      return { view, data: campaignsReport(await rm.campaigns(filter)), scope };
    case "channels": {
      const { channels, senders } = await rm.channels(filter);
      return { view, data: channelsReport(channels, senders), scope };
    }
    case "linkedin":
      return { view, data: linkedinReport(await rm.linkedin(filter)), scope };
    case "replies": {
      const { rows, suppressions } = await rm.replies(filter);
      // A suppression has no campaign, so a campaign filter hides the suppression counts instead of showing the whole organization's.
      return { view, data: repliesReport(rows, filter.campaignId ? null : suppressions), scope };
    }
    case "timeseries":
      return { view, data: timeSeriesReport(eachDay(scope.range), await rm.daily(filter)), scope };
  }
}

export async function getFilterOptions(deps: AnalyticsDeps, actor: Actor): Promise<FilterOptions & { timeZone: string; today: string }> {
  const stored = await deps.readModel.timeZone(actor.organizationId);
  const timeZone = (stored ? canonicalTimeZone(stored) : null) ?? "UTC";
  return { ...(await deps.readModel.filterOptions(actor.organizationId)), timeZone, today: localDay(deps.now?.() ?? new Date(), timeZone) };
}
