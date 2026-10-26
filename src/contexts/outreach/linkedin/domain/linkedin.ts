// Pure LinkedIn rules: step validation, rendering, limits, pacing, webhook keys. No I/O.
import { parseLinkedinRef } from "@/contexts/people/domain/linkedin-url";
import { stopReasonDetail } from "../../domain/campaign-view";
import { applyMergeFields, applySpin, applySpinLongest } from "../../domain/render";
import { isWithinWorkingHours, type WorkingHours } from "../../domain/working-hours";

export type ConnectionState = "none" | "request_sent" | "connected";

/** A LinkedIn campaign: step 1 is the invitation (note optional), every later step is a message sent after acceptance. */
export interface LinkedInStep {
  stepNumber: number;
  kind: "invitation" | "message";
  subject?: string;
  body: string;
  waitDays: number;
}

export const INVITE_NOTE_MAX = 300;
export const MAX_LINKEDIN_STEPS = 6;
export const MAX_LINKEDIN_WAIT_DAYS = 60;
/** An invitation nobody accepted after this many days ends the sequence. */
export const INVITE_EXPIRES_DAYS = 30;
export const MAX_INVITE_ATTEMPTS = 3;
export const MAX_RESOLVE_ATTEMPTS = 3;

export const DEFAULT_LINKEDIN_STEPS: LinkedInStep[] = [
  { stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}, I work with teams like {{company}}. Happy to connect.", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks for connecting, {{firstName}}. [[one line on what you help with]]", waitDays: 1 },
  { stepNumber: 3, kind: "message", body: "Hi {{firstName}}, a short follow-up. Would a quick chat make sense?", waitDays: 3 },
];

export interface LinkedInStepIssue {
  step: number | null;
  message: string;
}

export function validateLinkedInSteps(steps: LinkedInStep[]): LinkedInStepIssue[] {
  if (steps.length === 0) return [{ step: null, message: "Add at least one step." }];
  if (steps.length > MAX_LINKEDIN_STEPS) return [{ step: null, message: `A LinkedIn campaign can have at most ${MAX_LINKEDIN_STEPS} steps.` }];
  const issues: LinkedInStepIssue[] = [];
  steps.forEach((step, index) => {
    const n = index + 1;
    if (step.stepNumber !== n) issues.push({ step: n, message: "Steps must be numbered 1, 2, 3 in order." });
    const expected = index === 0 ? "invitation" : "message";
    if (step.kind !== expected) issues.push({ step: n, message: index === 0 ? "The first step is the connection request." : "Steps after the first are messages." });
    if (index > 0 && step.body.trim() === "") issues.push({ step: n, message: "The message is empty." });
    if (index === 0 && step.body.length > INVITE_NOTE_MAX * 2) issues.push({ step: n, message: `The note template is too long. LinkedIn allows ${INVITE_NOTE_MAX} characters after merge fields are filled.` });
    if (!Number.isInteger(step.waitDays) || step.waitDays < 0 || step.waitDays > MAX_LINKEDIN_WAIT_DAYS) {
      issues.push({ step: n, message: `Wait must be a whole number of days from 0 to ${MAX_LINKEDIN_WAIT_DAYS}.` });
    }
    if (index === 0 && step.waitDays !== 0) issues.push({ step: n, message: "The connection request goes out right away: wait 0 days." });
    if (index >= 2 && step.waitDays < 1) issues.push({ step: n, message: "A follow-up waits at least 1 day." });
    if ((step.body.match(/\{\{/g) ?? []).length !== (step.body.match(/\}\}/g) ?? []).length) {
      issues.push({ step: n, message: "A {{ }} merge field is missing a brace." });
    }
  });
  return issues;
}

/** Spin text and merge fields. LinkedIn messages are plain text: no signature, no footer. */
export function renderLinkedInText(template: string, variables: Record<string, string | null>, random: () => number): string {
  const withoutSignature = template.replace(/%\s*signature\s*%/gi, "");
  return applyMergeFields(applySpin(withoutSignature, random), variables).trim();
}

/** The note after rendering must fit LinkedIn's limit. A longer note is a hard failure for that lead, not something to cut. */
export function inviteNoteProblem(note: string): string | null {
  return note.length > INVITE_NOTE_MAX ? `The connection note is ${note.length} characters after merge fields. LinkedIn allows ${INVITE_NOTE_MAX}.` : null;
}

/**
 * Length of the invitation note for one lead after spin and merge fields, counted the way `inviteNoteProblem` counts it at send time.
 * Spin groups take their longest option, so a note flagged here can fail and a note that passes here cannot.
 */
export function inviteNoteLength(template: string, variables: Record<string, string | null>): number {
  const withoutSignature = template.replace(/%\s*signature\s*%/gi, "");
  return applyMergeFields(applySpinLongest(withoutSignature), variables).trim().length;
}

export interface LinkedInRules {
  invitesPerDayPremium: number;
  invitesPerDayFree: number;
  invitesPerWeek: number;
  inviteGapMinutes: [number, number];
  messageGapMinutes: [number, number];
  resolveGapMinutes: [number, number];
  /** People one account may read from searches per UTC day (spec 2.5, `searchLeadsPerDay`). */
  searchLeadsPerDay: number;
  /** Pause between two search pages (spec: 3 to 7 seconds). */
  searchGapSeconds: [number, number];
}

export const DEFAULT_LINKEDIN_RULES: LinkedInRules = {
  invitesPerDayPremium: 30,
  invitesPerDayFree: 5,
  // Unipile's provider limits page: about 200 per week on a paid account. 100 leaves room for manual use.
  invitesPerWeek: 100,
  inviteGapMinutes: [10, 20],
  messageGapMinutes: [2, 6],
  resolveGapMinutes: [1, 3],
  searchLeadsPerDay: 400,
  searchGapSeconds: [3, 7],
};

function range(raw: unknown, fallback: [number, number], min: number, max: number): [number, number] {
  if (Array.isArray(raw) && raw.length === 2) {
    const [lo, hi] = raw.map(Number);
    if (Number.isInteger(lo) && Number.isInteger(hi) && lo >= min && hi <= max && lo <= hi) return [lo, hi];
  }
  return fallback;
}

function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Per-organization LinkedIn rules from `channel_settings`. Out-of-bound values fall back to the defaults. */
export function linkedinRules(stored: Record<string, unknown> | null | undefined): LinkedInRules {
  const d = DEFAULT_LINKEDIN_RULES;
  return {
    invitesPerDayPremium: bounded(stored?.invitesPerDayPremium, d.invitesPerDayPremium, 1, 100),
    invitesPerDayFree: bounded(stored?.invitesPerDayFree, d.invitesPerDayFree, 1, 50),
    invitesPerWeek: bounded(stored?.invitesPerWeek, d.invitesPerWeek, 1, 200),
    inviteGapMinutes: range(stored?.inviteGapMinutes, d.inviteGapMinutes, 1, 240),
    messageGapMinutes: range(stored?.messageGapMinutes, d.messageGapMinutes, 1, 240),
    resolveGapMinutes: range(stored?.resolveGapMinutes, d.resolveGapMinutes, 1, 240),
    searchLeadsPerDay: bounded(stored?.searchLeadsPerDay, d.searchLeadsPerDay, 10, 2500),
    searchGapSeconds: range(stored?.searchGapSeconds, d.searchGapSeconds, 1, 600),
  };
}

/** The account's own limit wins; otherwise the premium or free rule. */
export function dailyInviteLimit(account: { dailyInviteLimit: number | null; isPremium: boolean }, rules: LinkedInRules): number {
  return account.dailyInviteLimit ?? (account.isPremium ? rules.invitesPerDayPremium : rules.invitesPerDayFree);
}

export type AccountBlock = "not_connected" | "limit_reached" | "throttled" | "outside_hours";

export interface AccountState {
  status: string;
  limitReachedUntil: Date | null;
  nextAllowedRunAt: Date | null;
  workingHours: WorkingHours;
}

/** Why an account may not act right now, or null when it may. */
export function accountBlock(now: Date, account: AccountState): AccountBlock | null {
  if (account.status !== "connected") return "not_connected";
  if (account.limitReachedUntil && account.limitReachedUntil.getTime() > now.getTime()) return "limit_reached";
  if (account.nextAllowedRunAt && account.nextAllowedRunAt.getTime() > now.getTime()) return "throttled";
  if (!isWithinWorkingHours(now, account.workingHours)) return "outside_hours";
  return null;
}

export type InviteBlock = "daily_limit" | "weekly_limit";

/** Whether another invitation fits today and this week. Counts include claims in flight and unknown outcomes. */
export function inviteBlock(counts: { today: number; week: number }, dailyLimit: number, weeklyLimit: number): InviteBlock | null {
  if (counts.today >= dailyLimit) return "daily_limit";
  if (counts.week >= weeklyLimit) return "weekly_limit";
  return null;
}

/** When a limit error stops an account: until the next rollover is unknowable, so wait a day. */
export const LIMIT_PAUSE_HOURS = 24;

/** Resolution retry delay: 60 minutes, then 120 (spec 2.4). */
export function resolveRetryMinutes(failures: number): number {
  return Math.min(60 * 2 ** (failures - 1), 1440);
}

/** Same retry ladder as email: 15 minutes, then 30. */
export function inviteRetryMinutes(attemptJustFailed: number): number {
  return 15 * attemptJustFailed;
}

export function pickMinutes([lo, hi]: [number, number], random: () => number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** Seconds to minutes: the account gap placed after a claim. */
export function nextRunAfter(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * `https://www.linkedin.com/in/jane-doe-123/` or a bare slug becomes `jane-doe-123`, by the rule people use. Member ids
 * and Sales Navigator URLs return null.
 */
export function linkedinSlug(input: string): string | null {
  const ref = parseLinkedinRef(input);
  return ref?.kind === "profile" ? ref.slug : null;
}

export function profileUrlFor(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

/** Webhook events this app reacts to, in normalized form. */
export type LinkedInInboundEvent =
  | { type: "connection_accepted"; account: string; member: string; name: string | null; profileUrl: string | null }
  | {
      type: "message_received";
      account: string;
      chat: string | null;
      messageId: string | null;
      text: string;
      /** True when the connected account wrote it (an echo of our own message or of the accepted note). */
      fromAccountOwner: boolean;
      /** The other person in the chat. Null when it cannot be resolved. */
      counterparty: string | null;
      /** Display name and profile URL of the sender, when the payload carries them (inbound messages only). */
      counterpartyName?: string | null;
      counterpartyProfileUrl?: string | null;
      /** When the provider says the message was sent (ISO 8601). */
      sentAt?: string | null;
    };

/**
 * Idempotency key for the ledger. A redelivery of the same fact yields the same key.
 * `message_received` keys on the message id, `new_relation` on the member. The organization id is part
 * of the key because `inbound_events` is unique on (provider, key) across tenants: without it, another
 * organization could claim a key first and drop the real event. Version 2 added the organization. Replay
 * reads the stored payload, never the key, so the old v1 rows need no translation.
 */
export function eventKey(event: LinkedInInboundEvent, organizationId: string): string | null {
  if (event.type === "message_received") return event.messageId ? `unipile:message_received:v2:${organizationId}:${event.account}:${event.messageId}` : null;
  return `unipile:new_relation:v2:${organizationId}:${event.account}:${event.member}`;
}

export const MAX_EVENT_ATTEMPTS = 8;
/** Backoff after a failed processing attempt: 5 s doubling, capped at 15 minutes. */
export function eventRetrySeconds(attempt: number): number {
  return Math.min(15 * 60, 5 * 2 ** (attempt - 1));
}

export interface LinkedInProgressInput {
  status: string;
  connectionState: string;
  /** Steps already completed (step 1 is the invitation). */
  currentStep: number;
  totalSteps: number;
  stopReason: string | null;
}

export interface LinkedInProgress {
  /** Short state name for a table cell. */
  label: string;
  /** One sentence for a tooltip or a title attribute. */
  detail: string;
  tone: "neutral" | "active" | "good" | "bad";
}

/** Reads the enrollment status and the connection state as one step of the LinkedIn sequence. */
export function describeLinkedInProgress(input: LinkedInProgressInput): LinkedInProgress {
  const { status, connectionState, currentStep, totalSteps, stopReason } = input;
  if (status === "replied") return { label: "Replied", detail: "The lead answered. The sequence stopped.", tone: "good" };
  if (status === "failed") return { label: "Failed", detail: stopReason ?? "The engine could not continue.", tone: "bad" };
  if (status === "suppressed") return { label: "Skipped", detail: stopReason ? stopReasonDetail(stopReason) : "Do not contact or suppressed.", tone: "neutral" };
  if (status === "cancelled") return { label: "Cancelled", detail: stopReason ? stopReasonDetail(stopReason) : "Removed from the sequence.", tone: "neutral" };
  if (status === "removed") return { label: "Removed", detail: "A person removed this lead from the campaign.", tone: "neutral" };
  if (status === "completed") {
    if (stopReason === "invite_not_accepted") {
      return { label: "Not accepted", detail: `The invitation was not accepted within ${INVITE_EXPIRES_DAYS} days.`, tone: "neutral" };
    }
    return { label: "Finished", detail: "Every step went out.", tone: "good" };
  }
  if (connectionState === "connected") {
    const next = currentStep + 1;
    return next <= totalSteps
      ? { label: "Connected", detail: `Connected. Message ${next - 1} of ${totalSteps - 1} goes out next.`, tone: "active" }
      : { label: "Connected", detail: "Connected. No messages left.", tone: "active" };
  }
  if (connectionState === "request_sent") return { label: "Invitation sent", detail: "Waiting for the lead to accept.", tone: "active" };
  return { label: "Queued", detail: "The profile is looked up, then the invitation goes out within the daily limit.", tone: "neutral" };
}
