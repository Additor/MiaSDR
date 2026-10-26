/**
 * Metric definitions for the analytics read model. Every number on the analytics pages comes from
 * one of the definitions below, and every rate goes through `ratio`.
 *
 * Conventions
 * - The window is [from 00:00, to + 1 day 00:00) in the organization's time zone.
 * - "Event" counts (sends, acceptances, replies by day) count things that happened inside the window.
 * - "Cohort" counts (contacted, replied, bounced, funnel stages) start from the people whose first
 *   touch fell inside the window and follow them to now. A rate never has a numerator outside its denominator.
 * - A send whose outcome is `unknown` (crashed or timed out mid-call, not yet reconciled) is reported on its
 *   own. It is not in `sent`, not in `contacted`, and not in any rate numerator or denominator that says "sent".
 */

export const CHANNELS = ["email", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Part over whole. Null when the whole is 0, so the UI shows a dash instead of 0%. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Send rows by status. `inFlight` is status `sending`: claimed, provider call not confirmed yet. */
export interface SendCounts {
  sent: number;
  unknown: number;
  failed: number;
  inFlight: number;
}

export const emptySendCounts = (): SendCounts => ({ sent: 0, unknown: 0, failed: 0, inFlight: 0 });

export function addSendCounts(a: SendCounts, b: SendCounts): SendCounts {
  return { sent: a.sent + b.sent, unknown: a.unknown + b.unknown, failed: a.failed + b.failed, inFlight: a.inFlight + b.inFlight };
}

/** Every send row that left the claim stage, whatever its outcome. */
export const attempted = (c: SendCounts): number => c.sent + c.unknown + c.failed + c.inFlight;

/** Share of attempts whose outcome nobody could confirm. */
export const unknownRate = (c: SendCounts): number | null => ratio(c.unknown, attempted(c));

export interface MetricDefinition {
  key: string;
  label: string;
  definition: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { key: "sent", label: "Sent", definition: "Send rows with status sent and sent_at inside the window. Unknown, failed and in-flight sends are excluded." },
  { key: "unknown", label: "Unknown outcome", definition: "Send rows with status unknown claimed inside the window. The provider call may or may not have gone out. Reported apart from sent until reconciled." },
  { key: "failed", label: "Failed", definition: "Send rows with status failed claimed inside the window." },
  { key: "inFlight", label: "In flight", definition: "Send rows with status sending claimed inside the window." },
  { key: "contacted", label: "Contacted", definition: "Enrollments whose first confirmed send (status sent) landed inside the window. One per person and campaign." },
  { key: "replied", label: "Replied", definition: "Contacted enrollments whose person has sent at least one inbound message on the same channel at or after the first send." },
  { key: "bounced", label: "Bounced", definition: "Contacted enrollments with status bounced." },
  { key: "replyRate", label: "Reply rate", definition: "Replied divided by contacted. Bounced contacts stay in the denominator because delivery is only observed through a bounce." },
  { key: "bounceRate", label: "Bounce rate", definition: "Bounced divided by contacted." },
  { key: "unknownRate", label: "Unknown rate", definition: "Unknown sends divided by all send attempts (sent, unknown, failed, in flight) in the window." },
  { key: "invited", label: "Invited", definition: "LinkedIn enrollments whose first confirmed invitation send landed inside the window." },
  { key: "accepted", label: "Accepted", definition: "Invited enrollments whose connection state is connected." },
  { key: "messaged", label: "Messaged", definition: "Accepted enrollments with at least one confirmed message send after the invitation." },
  { key: "linkedinReplied", label: "LinkedIn replied", definition: "Accepted enrollments whose person sent an inbound LinkedIn message at or after the invitation." },
  { key: "acceptanceRate", label: "Acceptance rate", definition: "Accepted divided by invited." },
  { key: "linkedinReplyRate", label: "LinkedIn reply rate", definition: "LinkedIn replied divided by accepted." },
  { key: "replies", label: "Replies", definition: "Inbound messages inside the window from people who were contacted before the message arrived. Each message counts once, even when the person is in several campaigns." },
  { key: "classified", label: "Classified share", definition: "Replies whose latest classification is applied (auto_applied, accepted or overridden) divided by all replies. Proposed classifications count as pending review." },
];

// ---------------------------------------------------------------- campaigns

export interface CampaignCounts {
  campaignId: string;
  name: string;
  channel: Channel;
  status: string;
  /** All enrollments, regardless of the window. */
  enrolled: number;
  contacted: number;
  replied: number;
  bounced: number;
  sends: SendCounts;
}

export interface CampaignRow extends CampaignCounts {
  replyRate: number | null;
  bounceRate: number | null;
  unknownRate: number | null;
}

export function campaignRow(counts: CampaignCounts): CampaignRow {
  return {
    ...counts,
    replyRate: ratio(counts.replied, counts.contacted),
    bounceRate: ratio(counts.bounced, counts.contacted),
    unknownRate: unknownRate(counts.sends),
  };
}

export function campaignTotals(rows: readonly CampaignCounts[]): CampaignRow {
  const totals = rows.reduce<CampaignCounts>(
    (sum, r) => ({
      ...sum,
      enrolled: sum.enrolled + r.enrolled,
      contacted: sum.contacted + r.contacted,
      replied: sum.replied + r.replied,
      bounced: sum.bounced + r.bounced,
      sends: addSendCounts(sum.sends, r.sends),
    }),
    { campaignId: "", name: "All campaigns", channel: "email", status: "", enrolled: 0, contacted: 0, replied: 0, bounced: 0, sends: emptySendCounts() },
  );
  return campaignRow(totals);
}

export interface CampaignsReport {
  rows: CampaignRow[];
  totals: CampaignRow;
}

export function campaignsReport(rows: readonly CampaignCounts[]): CampaignsReport {
  return { rows: rows.map(campaignRow), totals: campaignTotals(rows) };
}

// ---------------------------------------------------------------- channels and senders

export interface ChannelCounts {
  channel: Channel;
  contacted: number;
  replied: number;
  bounced: number;
  sends: SendCounts;
}

export interface SenderCounts {
  channel: Channel;
  senderId: string;
  /** Mailbox address or LinkedIn account name. */
  label: string;
  status: string;
  /** Distinct enrollments this sender confirmed a send for inside the window. */
  contacted: number;
  sends: SendCounts;
}

export interface ChannelsReport {
  channels: Array<ChannelCounts & { replyRate: number | null; bounceRate: number | null; unknownRate: number | null }>;
  senders: Array<SenderCounts & { unknownRate: number | null }>;
}

export function channelsReport(channels: readonly ChannelCounts[], senders: readonly SenderCounts[]): ChannelsReport {
  const byChannel = new Map(channels.map((c) => [c.channel, c]));
  return {
    // Both channels always appear, so an empty channel reads as zeros.
    channels: CHANNELS.map((channel) => {
      const c = byChannel.get(channel) ?? { channel, contacted: 0, replied: 0, bounced: 0, sends: emptySendCounts() };
      return { ...c, replyRate: ratio(c.replied, c.contacted), bounceRate: ratio(c.bounced, c.contacted), unknownRate: unknownRate(c.sends) };
    }),
    senders: senders.map((s) => ({ ...s, unknownRate: unknownRate(s.sends) })),
  };
}

// ---------------------------------------------------------------- linkedin

export interface LinkedInFunnelCounts {
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
}

export interface LinkedInCampaignFunnel extends LinkedInFunnelCounts {
  campaignId: string;
  name: string;
}

export interface LinkedInEventCounts {
  invites: SendCounts;
  messages: SendCounts;
  /** Connections accepted inside the window, whenever the invitation went out. */
  accepted: number;
  /** Inbound LinkedIn messages inside the window from contacted people. */
  replies: number;
}

export interface LinkedInAccountCounts {
  accountId: string;
  name: string;
  status: string;
  invites: SendCounts;
  messages: SendCounts;
  accepted: number;
}

export const emptyFunnel = (): LinkedInFunnelCounts => ({ invited: 0, accepted: 0, messaged: 0, replied: 0 });

export function funnelRates(f: LinkedInFunnelCounts) {
  return { acceptanceRate: ratio(f.accepted, f.invited), messageRate: ratio(f.messaged, f.accepted), replyRate: ratio(f.replied, f.accepted) };
}

export interface LinkedInReport {
  funnel: LinkedInFunnelCounts & ReturnType<typeof funnelRates>;
  events: LinkedInEventCounts;
  campaigns: Array<LinkedInCampaignFunnel & ReturnType<typeof funnelRates>>;
  accounts: LinkedInAccountCounts[];
}

export function linkedinReport(input: {
  campaigns: readonly LinkedInCampaignFunnel[];
  events: LinkedInEventCounts;
  accounts: readonly LinkedInAccountCounts[];
}): LinkedInReport {
  // Each enrollment belongs to one campaign, so campaign funnels add up to the overall funnel.
  const total = input.campaigns.reduce(
    (sum, c) => ({ invited: sum.invited + c.invited, accepted: sum.accepted + c.accepted, messaged: sum.messaged + c.messaged, replied: sum.replied + c.replied }),
    emptyFunnel(),
  );
  return {
    funnel: { ...total, ...funnelRates(total) },
    events: input.events,
    campaigns: input.campaigns.map((c) => ({ ...c, ...funnelRates(c) })),
    accounts: [...input.accounts],
  };
}

// ---------------------------------------------------------------- replies and classifications

export const CATEGORY_BUCKETS = ["customer", "interested", "not_interested", "other", "pending_review", "unclassified"] as const;
export type CategoryBucket = (typeof CATEGORY_BUCKETS)[number];

const BUCKET_LABELS: Record<CategoryBucket, string> = {
  customer: "Existing customer",
  interested: "Interested",
  not_interested: "Not interested",
  other: "Other",
  pending_review: "Pending review",
  unclassified: "Unclassified",
};

export const bucketLabel = (bucket: CategoryBucket): string => BUCKET_LABELS[bucket];

const APPLIED = new Set<CategoryBucket>(["customer", "interested", "not_interested", "other"]);

/**
 * The bucket one reply falls in. `latestStatus` and `appliedCategory` come from the reply's latest
 * classification that is applied or proposed (null when there is none, or only failed, stale or rejected ones).
 */
export function replyBucket(latestStatus: string | null, appliedCategory: string | null): CategoryBucket {
  if (latestStatus === null) return "unclassified";
  if (latestStatus === "proposed") return "pending_review";
  return APPLIED.has(appliedCategory as CategoryBucket) ? (appliedCategory as CategoryBucket) : "unclassified";
}

export interface ReplyCountRow {
  channel: Channel;
  bucket: CategoryBucket;
  /** Subcategory name for applied classifications, else null. */
  subcategory: string | null;
  replies: number;
}

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "manual", "complaint"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface RepliesReport {
  total: number;
  /** Replies with an applied category divided by all replies. */
  classifiedShare: number | null;
  byBucket: Array<{ bucket: CategoryBucket; label: string; replies: number; share: number | null }>;
  byChannel: Array<{ channel: Channel; total: number; byBucket: Record<CategoryBucket, number> }>;
  byReplyType: Array<{ bucket: CategoryBucket; name: string; replies: number }>;
  /** Suppression rows created in the window. Null when a campaign filter is on: a suppression has no campaign. */
  suppressions: Record<SuppressionReason, number> | null;
}

const emptyBuckets = (): Record<CategoryBucket, number> => ({ customer: 0, interested: 0, not_interested: 0, other: 0, pending_review: 0, unclassified: 0 });

export function repliesReport(rows: readonly ReplyCountRow[], suppressions: Partial<Record<SuppressionReason, number>> | null): RepliesReport {
  const totals = emptyBuckets();
  const perChannel = new Map<Channel, Record<CategoryBucket, number>>(CHANNELS.map((c) => [c, emptyBuckets()]));
  const subs = new Map<string, { bucket: CategoryBucket; name: string; replies: number }>();
  for (const r of rows) {
    totals[r.bucket] += r.replies;
    (perChannel.get(r.channel) as Record<CategoryBucket, number>)[r.bucket] += r.replies;
    if (r.subcategory) {
      const key = `${r.bucket}/${r.subcategory}`;
      const entry = subs.get(key) ?? { bucket: r.bucket, name: r.subcategory, replies: 0 };
      entry.replies += r.replies;
      subs.set(key, entry);
    }
  }
  const total = CATEGORY_BUCKETS.reduce((sum, b) => sum + totals[b], 0);
  const applied = [...APPLIED].reduce((sum, b) => sum + totals[b], 0);
  return {
    total,
    classifiedShare: ratio(applied, total),
    byBucket: CATEGORY_BUCKETS.map((bucket) => ({ bucket, label: bucketLabel(bucket), replies: totals[bucket], share: ratio(totals[bucket], total) })),
    byChannel: CHANNELS.map((channel) => {
      const byBucket = perChannel.get(channel) as Record<CategoryBucket, number>;
      return { channel, total: CATEGORY_BUCKETS.reduce((sum, b) => sum + byBucket[b], 0), byBucket };
    }),
    byReplyType: [...subs.values()].sort((a, b) => b.replies - a.replies || a.name.localeCompare(b.name)),
    suppressions: suppressions === null ? null : Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, suppressions[r] ?? 0])) as Record<SuppressionReason, number>,
  };
}

// ---------------------------------------------------------------- time series

export const DAILY_METRICS = [
  "email_sent",
  "email_unknown",
  "email_failed",
  "linkedin_invites",
  "linkedin_accepted",
  "linkedin_messages",
  "linkedin_unknown",
  "linkedin_failed",
  "replies_email",
  "replies_linkedin",
] as const;
export type DailyMetric = (typeof DAILY_METRICS)[number];

export const DAILY_METRIC_LABELS: Record<DailyMetric, string> = {
  email_sent: "Email sent",
  email_unknown: "Email unknown",
  email_failed: "Email failed",
  linkedin_invites: "LinkedIn invites sent",
  linkedin_accepted: "LinkedIn accepted",
  linkedin_messages: "LinkedIn messages sent",
  linkedin_unknown: "LinkedIn unknown",
  linkedin_failed: "LinkedIn failed",
  replies_email: "Email replies",
  replies_linkedin: "LinkedIn replies",
};

/** One count of one metric on one local day (YYYY-MM-DD in the organization's zone). */
export interface DailyEventRow {
  day: string;
  metric: DailyMetric;
  count: number;
}

export type DailyPoint = { day: string } & Record<DailyMetric, number>;

export interface TimeSeriesReport {
  points: DailyPoint[];
  totals: Record<DailyMetric, number>;
}

/** Zero-filled series: every day in the range has a point, and rows outside the range are ignored. */
export function timeSeriesReport(days: readonly string[], rows: readonly DailyEventRow[]): TimeSeriesReport {
  const zero = (): Record<DailyMetric, number> => Object.fromEntries(DAILY_METRICS.map((m) => [m, 0])) as Record<DailyMetric, number>;
  const byDay = new Map(days.map((d) => [d, zero()]));
  const totals = zero();
  for (const row of rows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point[row.metric] += row.count;
    totals[row.metric] += row.count;
  }
  return { points: days.map((day) => ({ day, ...(byDay.get(day) as Record<DailyMetric, number>) })), totals };
}
