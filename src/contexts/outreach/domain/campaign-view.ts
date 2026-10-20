// Pure display rules of the campaign pages: labels, the status summary, the Start checklist and the add-leads confirmation.
import { humanizeToken } from "@/shared/humanize";
import type { CampaignStatus } from "./campaign";
import { enrollmentListHref, enrollmentTabOf, parseEnrollmentListQuery, type EnrollmentListQuery, type TabCounts } from "./enrollment-list";
import { ALREADY_CONTACTED_BY_ACCOUNT } from "./cross-campaign-notice";
import { heldByCampaign } from "./lead-status";

export type OutreachChannelName = "email" | "linkedin";

const num = (n: number) => n.toLocaleString("en-US");

export const CHANNEL_LABELS: Record<OutreachChannelName, string> = { email: "Email", linkedin: "LinkedIn" };

/** Product wording for a channel ("linkedin" shows as "LinkedIn"). An unknown channel falls back to a readable form of its token. */
export const channelLabel = (channel: string): string => (CHANNEL_LABELS as Record<string, string>)[channel] ?? humanizeToken(channel);

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = { draft: "Draft", active: "Active", paused: "Paused", completed: "Completed" };

export const campaignStatusLabel = (status: string): string => (CAMPAIGN_STATUS_LABELS as Record<string, string>)[status] ?? humanizeToken(status);

/** Mirrors `enrollments_status_ck`. "In sequence" matches the tab of the lead table. */
export const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  active: "In sequence",
  replied: "Replied",
  completed: "Completed",
  bounced: "Bounced",
  suppressed: "Suppressed",
  failed: "Failed",
  cancelled: "Cancelled",
  removed: "Removed",
};

export const enrollmentStatusLabel = (status: string): string => ENROLLMENT_STATUS_LABELS[status] ?? humanizeToken(status);

/**
 * The status an enrollment shows beside its campaign. A live enrollment of a campaign that is not active sends nothing,
 * so it reads "Paused with campaign" instead of a bare "In sequence", by the rule the lead status uses. `status` picks
 * the badge tone.
 */
export function enrollmentDisplayStatus(status: string, campaignStatus: string): { status: string; label: string } {
  if (heldByCampaign(status, campaignStatus)) return { status: "paused", label: "Paused with campaign" };
  return { status, label: enrollmentStatusLabel(status) };
}

/** Stop reasons the engine writes itself. Anything else is free text (an error message) and prints as stored. */
export const STOP_REASON_LABELS: Record<string, string> = {
  replied: "Replied",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  do_not_contact: "Do not contact",
  removed: "Removed",
  converted: "Became a contact",
  invite_not_accepted: "Invitation not accepted",
  already_contacted_by_account: "Account already invited this person",
};

const TOKEN = /^[a-z][a-z0-9_]*$/;

/** A known reason gets its label, a bare token is humanized, and a sentence stays as written. */
export function stopReasonLabel(reason: string): string {
  return STOP_REASON_LABELS[reason] ?? (TOKEN.test(reason) ? humanizeToken(reason) : reason);
}

/** The sentence a tooltip shows for a stop reason: the account rule gets its explanation, any other reason its label. */
export function stopReasonDetail(reason: string): string {
  if (reason === ALREADY_CONTACTED_BY_ACCOUNT) return "This LinkedIn account already invited this person in another campaign, so it did not invite them again.";
  return stopReasonLabel(reason);
}

/** The reason beside a status badge, or null when it only repeats the status. */
export function stopReasonNote(status: string, reason: string | null): string | null {
  if (!reason || reason === status) return null;
  const label = stopReasonLabel(reason);
  return label === enrollmentStatusLabel(status) ? null : label;
}

export interface SummaryEntry {
  label: string;
  value: string;
  hint?: string;
}

/** Leads still waiting for a step or inside the steps: every lead that has not replied, finished or stopped. */
export const leadsInProgress = (counts: TabCounts): number => Math.max(0, counts.all - counts.replied - counts.finished - counts.stopped);

/**
 * The status line of the campaign header. Email and LinkedIn share the labels, so a lead count reads the same on both,
 * and the labels are the lead status words of the Leads tab filters. `counts` and `sent` cover the whole campaign,
 * whatever filter or search is active.
 */
export function campaignSummary(input: { channel: OutreachChannelName; counts: TabCounts; sent: number }): SummaryEntry[] {
  const { channel, counts, sent } = input;
  return [
    { label: "Leads", value: num(counts.all), hint: "Leads in this campaign, not counting removed ones." },
    { label: "Sent", value: num(sent), hint: channel === "linkedin" ? "Invitations and messages sent." : "Emails sent." },
    { label: "In progress", value: num(leadsInProgress(counts)), hint: "Queued, in sequence or paused." },
    { label: "Replied", value: num(counts.replied) },
    { label: "Finished", value: num(counts.finished), hint: "Every step went out." },
    { label: "Stopped", value: num(counts.stopped), hint: "Bounced, unsubscribed, do not contact, failed or cancelled." },
  ];
}

/** Progress text of a campaign row. `stopped` excludes replies, which have their own count. */
export function emailProgressText(c: { sent: number; replied: number; completed: number; stopped: number }): string {
  return `${num(c.sent)} sent, ${num(c.replied)} replied, ${num(c.completed)} finished, ${num(Math.max(0, c.stopped - c.replied))} stopped`;
}

export function linkedinProgressText(c: { invited: number; connected: number; replied: number }): string {
  return `${num(c.invited)} invited, ${num(c.connected)} connected, ${num(c.replied)} replied`;
}

export interface StartBlocker {
  code: "no_sender" | "offline_sender" | "fix_steps" | "unfinished_steps" | "no_leads";
  message: string;
}

/**
 * What stops a draft from starting, in the order a person fixes it. The server checks the same rules and answers with
 * the same wording when a start slips through, so this list only saves the round trip. A resume of a paused campaign
 * never lands here: its steps and leads already passed once.
 */
export function startBlockers(input: {
  channel: OutreachChannelName;
  status: string;
  leads: number;
  connectedSenders: number;
  offlineAssigned: string[];
  stepIssues: number;
  placeholderSteps: number[];
}): StartBlocker[] {
  if (input.status !== "draft") return [];
  const blockers: StartBlocker[] = [];
  const noun = input.channel === "linkedin" ? "LinkedIn account" : "mailbox";
  if (input.connectedSenders === 0) blockers.push({ code: "no_sender", message: `Connect a ${noun} in Settings to start.` });
  else if (input.offlineAssigned.length > 0) blockers.push({ code: "offline_sender", message: `Reconnect or remove ${input.offlineAssigned.join(", ")} under Senders to start.` });
  if (input.stepIssues > 0) blockers.push({ code: "fix_steps", message: "Fix the steps to start." });
  if (input.placeholderSteps.length > 0) {
    blockers.push({ code: "unfinished_steps", message: `Replace the [[bracketed text]] in step ${input.placeholderSteps.join(", ")} to start.` });
  }
  if (input.leads === 0) blockers.push({ code: "no_leads", message: "Add leads to start." });
  return blockers;
}

/** The tabs of the campaign page. Leads is the default. */
export const CAMPAIGN_TABS = ["leads", "sequence", "settings"] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number];

export const CAMPAIGN_TAB_LABELS: Record<CampaignTab, string> = { leads: "Leads", sequence: "Sequence", settings: "Settings" };

type SearchParams = Record<string, string | string[] | undefined>;

const firstOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Reads `?tab=` of the campaign page. Anything unknown, including the lead status values older links carried, opens Leads. */
export function parseCampaignTab(value: string | string[] | undefined): CampaignTab {
  const tab = firstOf(value);
  return CAMPAIGN_TABS.find((t) => t === tab) ?? "leads";
}

/** URL of a campaign page tab. Leads is the default, so its URL stays bare. */
export const campaignTabHref = (base: string, tab: CampaignTab): string => (tab === "leads" ? base : `${base}?tab=${tab}`);

/**
 * The lead table filters on `?status=` because `?tab=` picks the page tab. A link that still carries a lead status in
 * `?tab=` (`/campaigns/ID?tab=replied`) keeps working: it opens Leads with that filter. The filter values before the lead
 * status vocabulary (`pending`, `completed`, `bounced`) open Queued, Finished and Stopped.
 */
export function parseLeadsQuery(params: SearchParams): EnrollmentListQuery {
  const legacy = firstOf(params.tab);
  const status = firstOf(params.status) ?? (enrollmentTabOf(legacy) ? legacy : undefined);
  return parseEnrollmentListQuery({ ...params, tab: status });
}

/** URL of the lead table for a query: the status filter goes in `?status=`, the other parts stay as `enrollmentListHref` writes them. */
export function leadsListHref(base: string, query: Partial<EnrollmentListQuery>): string {
  const href = enrollmentListHref(base, { ...query, tab: "all" });
  if (!query.tab || query.tab === "all") return href;
  const [path, rest] = href.split("?");
  return `${path}?status=${query.tab}${rest ? `&${rest}` : ""}`;
}

/** The tab of the campaign page where a Start blocker gets fixed, or null when the fix lives in the app settings. */
export function blockerTab(code: StartBlocker["code"]): CampaignTab | null {
  switch (code) {
    case "offline_sender":
      return "settings";
    case "fix_steps":
    case "unfinished_steps":
      return "sequence";
    case "no_leads":
      return "leads";
    case "no_sender":
      return null;
  }
}

/** The sending rules of the channel as one sentence, or null when there is nothing to say yet. Start and Settings show the same text. */
export function sendingRulesLine(input: {
  channel: OutreachChannelName;
  /** Email: the organization's gap range in minutes. */
  gapMinutes?: [number, number];
  /** LinkedIn: invitation limits of the accounts that will send. */
  inviteLimits?: Array<{ daily: number; weekly: number }>;
}): string | null {
  if (input.channel === "email") {
    const [lo, hi] = input.gapMinutes ?? [18, 24];
    return `Each mailbox sends inside its working hours and under its daily limit, ${lo === hi ? `${lo} minutes` : `${lo} to ${hi} minutes`} apart.`;
  }
  if (!input.inviteLimits || input.inviteLimits.length === 0) return null;
  const range = (values: number[]) => (Math.min(...values) === Math.max(...values) ? num(values[0]) : `${num(Math.min(...values))} to ${num(Math.max(...values))}`);
  return `Each account sends ${range(input.inviteLimits.map((l) => l.daily))} invitations a day and ${range(input.inviteLimits.map((l) => l.weekly))} a week, inside its working hours.`;
}

/** Facts the Start dialog lists. Every line comes from stored settings, so the dialog never promises more than the engine does. */
export function startSummaryLines(input: {
  channel: OutreachChannelName;
  leads: number;
  senders: string[];
  gapMinutes?: [number, number];
  inviteLimits?: Array<{ daily: number; weekly: number }>;
}): string[] {
  const noun = input.channel === "linkedin" ? "account" : "mailbox";
  const lines = [`${num(input.leads)} ${input.leads === 1 ? "lead is" : "leads are"} in this campaign.`];
  lines.push(input.senders.length > 0 ? `Sending from ${input.senders.join(", ")}.` : `Sending from every connected ${noun}.`);
  const rules = sendingRulesLine(input);
  if (rules) lines.push(rules);
  return lines;
}

/** People one add takes at most. Mirrors `MAX_ENROLL_BATCH` of the use case, which the browser cannot import. */
export const ENROLL_BATCH_LIMIT = 5000;

/** Enrolling by search asks first when the search is empty (every lead) or the match reaches this many people. */
export const ENROLL_CONFIRM_FROM = 50;

export const enrollNeedsConfirmation = (input: { query: string; wouldAdd: number }): boolean => input.wouldAdd > 0 && (input.query.trim() === "" || input.wouldAdd >= ENROLL_CONFIRM_FROM);
