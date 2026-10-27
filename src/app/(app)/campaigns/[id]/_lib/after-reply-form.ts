// Pure rules of the Follow-ups after a reply form: delay units, the step list the person edits, its validation and the payload.
// The API stores delays in minutes. The form shows days unless a stored delay only fits hours or minutes.

import { AFTER_REPLY_MODE_LABELS } from "@/contexts/conversations/after-reply/domain/after-reply";
import { MAX_STEPS, MAX_TAGS } from "@/contexts/conversations/after-reply/domain/sequences";

export const MAX_FOLLOW_UP_STEPS = MAX_STEPS;
const MAX_TAG_LENGTH = 80;

export const DELAY_UNITS = [
  { value: "minutes", label: "Minutes", size: 1 },
  { value: "hours", label: "Hours", size: 60 },
  { value: "days", label: "Days", size: 1440 },
] as const;
export type DelayUnit = (typeof DELAY_UNITS)[number]["value"];

export const delayUnitSize = (unit: DelayUnit): number => DELAY_UNITS.find((u) => u.value === unit)?.size ?? 1;

/** The largest unit that shows a delay as a whole number. */
export function splitDelay(minutes: number): { amount: number; unit: DelayUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

/** Minutes for an amount typed in a unit. Fractions and negative numbers become whole numbers of zero or more. */
export function delayToMinutes(amount: number, unit: DelayUnit): number {
  return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) * delayUnitSize(unit) : 0;
}

/** A stored delay as a person reads it: "3 days", "1 hour", "90 minutes". */
export function delayText(minutes: number): string {
  if (minutes === 0) return "No wait";
  const { amount, unit } = splitDelay(minutes);
  const singular = unit.slice(0, -1);
  return `${amount} ${amount === 1 ? singular : unit}`;
}

export interface EditorStep {
  name: string;
  delayMinutes: number;
  subjectTemplate: string;
  bodyTemplate: string;
  aiInstructions: string;
  knowledgeTags: string[];
}

/** The steps as the API returns them. */
export interface StepFromApi {
  name: string;
  delayMinutes: number;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  aiInstructions: string;
  knowledgeTags: string[];
}

export const REPLY_STEP_NAME = "Reply to their answer";
export const FOLLOW_UP_NAME = "Follow-up";

export const blankReply = (): EditorStep => ({ name: REPLY_STEP_NAME, delayMinutes: 0, subjectTemplate: "", bodyTemplate: "", aiInstructions: "", knowledgeTags: [] });

export const blankFollowUp = (): EditorStep => ({ name: FOLLOW_UP_NAME, delayMinutes: 3 * 1440, subjectTemplate: "", bodyTemplate: "", aiInstructions: "", knowledgeTags: [] });

/** The saved steps, or the one reply step a campaign starts with. */
export function stepsFromApi(steps: StepFromApi[]): EditorStep[] {
  if (steps.length === 0) return [blankReply()];
  return steps.map((s) => ({
    name: s.name,
    delayMinutes: s.delayMinutes,
    subjectTemplate: s.subjectTemplate ?? "",
    bodyTemplate: s.bodyTemplate ?? "",
    aiInstructions: s.aiInstructions,
    knowledgeTags: s.knowledgeTags,
  }));
}

/** Knowledge tags typed as a comma separated list. Empty entries and repeats (any case) drop out. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** The request body for `steps`. Step 1 always has no delay, as the API requires. */
export function stepsPayload(steps: EditorStep[]) {
  return steps.map((s, index) => ({
    name: s.name.trim() || (index === 0 ? REPLY_STEP_NAME : FOLLOW_UP_NAME),
    delayMinutes: index === 0 ? 0 : s.delayMinutes,
    subjectTemplate: s.subjectTemplate.trim() || null,
    bodyTemplate: s.bodyTemplate.trim() || null,
    aiInstructions: s.aiInstructions.trim(),
    knowledgeTags: s.knowledgeTags,
  }));
}

export interface StepIssue {
  /** 1-based, or null for a problem with the whole list. */
  step: number | null;
  message: string;
}

/** The same rules the server applies, so a person sees the problem next to the field before saving. */
export function validateSteps(steps: EditorStep[]): StepIssue[] {
  if (steps.length === 0) return [{ step: null, message: "Add the reply step." }];
  const issues: StepIssue[] = [];
  if (steps.length > MAX_FOLLOW_UP_STEPS) issues.push({ step: null, message: `Use at most ${MAX_FOLLOW_UP_STEPS} steps.` });
  steps.forEach((s, index) => {
    const step = index + 1;
    if (s.aiInstructions.trim() === "") issues.push({ step, message: `Step ${step} needs a goal.` });
    if (index > 0 && s.delayMinutes < 1) issues.push({ step, message: `Step ${step} must wait at least one minute.` });
    if (s.knowledgeTags.length > MAX_TAGS) issues.push({ step, message: `Step ${step}: use at most ${MAX_TAGS} knowledge tags.` });
    if (s.knowledgeTags.some((t) => t.length > MAX_TAG_LENGTH)) issues.push({ step, message: `Step ${step}: a knowledge tag can have at most ${MAX_TAG_LENGTH} characters.` });
  });
  return issues;
}

/** Whether the form differs from what is saved. Compares payloads, so trailing spaces alone do not count as a change. */
export function formChanged(input: { mode: string; steps: EditorStep[]; saved: { mode: string; steps: EditorStep[] } }): boolean {
  if (input.mode !== input.saved.mode) return true;
  if (input.mode === "handoff") return false;
  return JSON.stringify(stepsPayload(input.steps)) !== JSON.stringify(stepsPayload(input.saved.steps));
}

/** Why the AI option is locked, with the line about private replies added for a personal campaign when the reason lacks it. */
export function lockedNote(reason: string | null, personal: boolean): string | null {
  if (!reason) return null;
  return personal && !/out of the inbox/i.test(reason) ? `${reason} Replies stay out of the Inbox.` : reason;
}

/** "3 follow-ups use an earlier version", or null when every run uses the newest. */
export function earlierVersionNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 follow-up uses an earlier version" : `${count.toLocaleString("en-US")} follow-ups use an earlier version`;
}

/** The ids of `FIXED_STOP_RULES` that `FIXED_STOPS_LINE` names. A test fails when the rules change and the line does not. */
export const FIXED_STOPS_LINE_COVERS = ["reply", "do_not_contact", "unsubscribe", "bounce", "suppressed", "record_closed", "converted"] as const;

/** The fixed stop rules in one muted line, under the reply types that stop follow-ups. */
export const FIXED_STOPS_LINE =
  "Follow-ups also stop when the person replies again, is marked do not contact, unsubscribes, bounces, lands on the suppression list or becomes a contact, and when reply handling is closed.";

/**
 * The names of the reply types set to stop follow-ups, as one line. Asked to stop always stops them, so an empty list
 * means the organization has no reply types yet: they are created on first use.
 */
export function stopTypesLine(names: readonly string[]): string {
  return names.length === 0 ? "No reply types yet." : names.join(", ");
}

/** The Off option of a campaign. A personal campaign keeps replies private, so the Inbox never sees them. */
export function handoffOption(personal: boolean): { title: string; description: string } {
  if (personal) return { title: "Off", description: "The sequence stops for that lead, and the reply stays out of the Inbox." };
  return {
    title: AFTER_REPLY_MODE_LABELS.handoff,
    description: "The sequence stops for that lead and the reply waits in the Inbox. The AI still drafts a first reply for reply types set to Write one.",
  };
}
