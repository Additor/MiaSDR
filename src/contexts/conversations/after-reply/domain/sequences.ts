import { ConflictError, ValidationError } from "@/shared/errors";
import type { FollowUpsRule } from "../../domain/reply-type";

/**
 * Pure rules for a campaign's After a reply flow. The flow has versions; a published version is immutable and a
 * run pins the version it started on. Step 1 is the reply, later steps are timed follow-ups. Nothing here
 * reads or writes data, and nothing here can send: a step only ever asks for a draft a person approves.
 */

export const MAX_STEPS = 30;
export const MAX_TAGS = 50;
const MINUTES_PER_DAY = 1440;

export interface StepInput {
  name: string;
  /** Minutes after the previous message was sent. Step 1 is always 0. */
  delayMinutes: number;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  aiInstructions: string;
  knowledgeTags: string[];
}

export type StepType = "reply" | "follow_up";
export const stepTypeAt = (position: number): StepType => (position === 1 ? "reply" : "follow_up");

const text = (value: unknown, label: string, max: number, required: boolean): string | null => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw new ValidationError(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return trimmed;
};

export function parseSequenceName(value: unknown): string {
  return text(value, "Name", 160, true) as string;
}

export function parseDescription(value: unknown): string | null {
  return text(value, "Description", 4000, false);
}

/** Validates the editable shape of every step and fixes the delay rules by position. */
export function parseSteps(raw: unknown): StepInput[] {
  if (!Array.isArray(raw)) throw new ValidationError("Steps must be a list.");
  if (raw.length > MAX_STEPS) throw new ValidationError(`A flow can have at most ${MAX_STEPS} steps.`);
  return raw.map((entry, index) => {
    const position = index + 1;
    const at = `Step ${position}`;
    if (typeof entry !== "object" || entry === null) throw new ValidationError(`${at} is not an object.`);
    const step = entry as Record<string, unknown>;
    const delay = step.delayMinutes;
    if (typeof delay !== "number" || !Number.isSafeInteger(delay) || delay < 0) throw new ValidationError(`${at}: the delay must be a whole number of minutes, zero or more.`);
    if (position === 1 && delay !== 0) throw new ValidationError("Step 1 is the immediate reply and has no delay.");
    if (position > 1 && delay === 0) throw new ValidationError(`${at}: a follow-up must wait at least one minute.`);
    const tagsRaw = step.knowledgeTags ?? [];
    if (!Array.isArray(tagsRaw) || tagsRaw.length > MAX_TAGS) throw new ValidationError(`${at}: knowledge tags must be a list of at most ${MAX_TAGS}.`);
    const tags = tagsRaw.map((t) => (text(t, `${at}: a knowledge tag`, 80, true) as string).toLowerCase());
    if (new Set(tags).size !== tags.length) throw new ValidationError(`${at}: knowledge tags must not repeat.`);
    return {
      name: text(step.name, `${at}: the name`, 120, true) as string,
      delayMinutes: delay,
      subjectTemplate: text(step.subjectTemplate, `${at}: the subject template`, 500, false),
      bodyTemplate: text(step.bodyTemplate, `${at}: the body template`, 20_000, false),
      aiInstructions: text(step.aiInstructions, `${at}: the AI instruction`, 8000, true) as string,
      knowledgeTags: tags,
    };
  });
}

/** What publishing needs: at least the immediate reply, and every step complete. */
export function assertPublishable(steps: readonly StepInput[]): void {
  if (steps.length === 0) throw new ConflictError("Add the immediate reply step before publishing.");
  parseSteps(steps);
}

export const stepsEqual = (a: readonly StepInput[], b: readonly StepInput[]) => JSON.stringify(a) === JSON.stringify(b);

// Run and step-run state machines ---------------------------------------------------------------------

export type RunStatus = "active" | "paused" | "interrupted" | "completed" | "cancelled";
export type StepRunStatus = "scheduled" | "drafting" | "awaiting_review" | "sent" | "skipped" | "cancelled" | "failed";

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  active: ["paused", "interrupted", "completed", "cancelled"],
  paused: ["active", "interrupted", "cancelled"],
  interrupted: [],
  completed: [],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<StepRunStatus, readonly StepRunStatus[]> = {
  scheduled: ["drafting", "skipped", "cancelled", "awaiting_review"],
  drafting: ["awaiting_review", "scheduled", "failed", "cancelled", "skipped"],
  awaiting_review: ["sent", "skipped", "cancelled", "scheduled", "failed"],
  failed: ["scheduled", "skipped", "cancelled"],
  sent: [],
  skipped: [],
  cancelled: [],
};

export const canRunTransition = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to);
export const canStepTransition = (from: StepRunStatus, to: StepRunStatus) => STEP_TRANSITIONS[from].includes(to);

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw new ConflictError(`A ${from} follow-up run cannot become ${to}.`);
}

export function assertStepTransition(from: StepRunStatus, to: StepRunStatus): void {
  if (!canStepTransition(from, to)) throw new ConflictError(`A ${from.replace(/_/g, " ")} step cannot become ${to.replace(/_/g, " ")}.`);
}

/** Steps a run still has to get through. `failed` stays open so a person can retry or skip it. */
export const OPEN_STEP_STATUSES: readonly StepRunStatus[] = ["scheduled", "drafting", "awaiting_review", "failed"];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["active", "paused"];

// What stops a run ------------------------------------------------------------------------------------

/** The reason stored on a run that ended because its campaign turned After a reply off. */
export const AFTER_REPLY_OFF = "after_reply_off";

export type InterruptReason = "reply" | "do_not_contact" | "unsubscribed" | "bounce" | "suppressed" | "terminal_stage" | "record_closed" | "converted" | typeof AFTER_REPLY_OFF;

/**
 * Whether the record's reply type lets follow-ups run. The type's Follow-ups rule (`reply_types.follow_ups`) decides;
 * a record without a type, or a type the read could not find, starts nothing.
 */
export const followUpsContinue = (followUps: FollowUpsRule | null): boolean => followUps === "continue";

const LEGACY_TERMINAL_KEYS = new Set(["do_not_contact", "left_company", "wrong_contact", "connected_to_different_contact", "customer"]);

/**
 * @deprecated The old key list. Only `domain/reply-type.test.ts` reads it, to compare the seeded rules with the old
 * key rules. P3 deletes it with that comparison. Nothing decides by it.
 */
export const NO_START_KEYS: readonly string[] = [...LEGACY_TERMINAL_KEYS, "out_of_office"];

/**
 * @deprecated The old key and group rule. Only `domain/reply-type.test.ts` reads it, to compare the seeded rules with
 * the old key rules. P3 deletes it with that comparison. Nothing decides by it.
 */
export function isTerminalReplyType(groupKey: string | null, replyTypeKey: string | null): boolean {
  return groupKey === "not_interested" || (replyTypeKey !== null && LEGACY_TERMINAL_KEYS.has(replyTypeKey));
}

export interface InterruptFacts {
  run: { triggerMessageId: string; replyTypeId: string };
  record: {
    latestInboundMessageId: string | null;
    replyTypeId: string | null;
    groupKey: string | null;
    replyTypeKey: string | null;
    /** The Follow-ups rule of the record's reply type (`reply_types.follow_ups`), or null without a type. */
    followUps: FollowUpsRule | null;
    workflowState: string;
  };
  doNotContact: boolean;
  /** Reason on the suppression list for the person's address, if any. */
  suppression: "unsubscribed" | "bounced" | "manual" | "complaint" | null;
  /** The person is a contact (`people.lifecycle`). A contact starts no follow-up run, and a run that survives a conversion ends here. */
  contact: boolean;
  /** The run's flow may keep running: a campaign-owned flow that is still active, or a legacy standalone flow. False once its campaign switches After a reply off. */
  flowActive: boolean;
}

/**
 * Why a run must stop now, or null. A move to a reply type whose Follow-ups rule is Stop ends the run. A run whose
 * record still carries the type it started on is spared: rules apply at decision time, so an edit of that type's
 * rule later does not reach back into a run already going.
 */
export function interruptReason(facts: InterruptFacts): InterruptReason | null {
  if (facts.doNotContact) return "do_not_contact";
  if (facts.suppression === "unsubscribed" || facts.suppression === "complaint") return "unsubscribed";
  if (facts.suppression === "bounced") return "bounce";
  if (facts.suppression === "manual") return "suppressed";
  if (facts.contact) return "converted";
  if (facts.record.latestInboundMessageId !== null && facts.record.latestInboundMessageId !== facts.run.triggerMessageId) return "reply";
  if (facts.record.workflowState === "closed") return "record_closed";
  if (facts.record.replyTypeId !== facts.run.replyTypeId && facts.record.followUps === "stop") return "terminal_stage";
  if (!facts.flowActive) return AFTER_REPLY_OFF;
  return null;
}

/** A person already answered the latest inbound message by hand: an outbound message at or after it. The one definition of `answered`. */
export function isAnswered(record: { lastInboundAt: Date | null; lastOutboundAt: Date | null }): boolean {
  return Boolean(record.lastInboundAt && record.lastOutboundAt && record.lastOutboundAt >= record.lastInboundAt);
}

/**
 * First step a new run starts at, or null when no run should start. Step 1 ("Reply to their answer") is skipped when a
 * person already replied by hand (`answered`), when the caller asks (`skipReply`), and when the record's reply type is
 * set to Don't write a reply draft (`replyDraft: false`). The later steps still run.
 */
export function startPosition(input: { stepCount: number; answered: boolean; skipReply?: boolean; replyDraft?: boolean | null }): number | null {
  const position = input.answered || input.skipReply || input.replyDraft === false ? 2 : 1;
  return input.stepCount >= position ? position : null;
}

// Scheduling in the organization's time zone ----------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(date: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

export function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function offsetAt(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant whose wall clock in `timeZone` reads the given fields. A repeated time takes its first occurrence; a time skipped by a DST jump moves forward. */
function instantOf(fields: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string, millis: number): Date {
  const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const candidates = [asUtc - offsetAt(new Date(asUtc - 43_200_000), timeZone), asUtc - offsetAt(new Date(asUtc + 43_200_000), timeZone)];
  const reads = (instant: number) => {
    const p = parts(new Date(instant), timeZone);
    return p.year === fields.year && p.month === fields.month && p.day === fields.day && p.hour === fields.hour && p.minute === fields.minute;
  };
  const valid = candidates.filter(reads);
  const instant = valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
  return new Date(instant + millis);
}

/**
 * When a step becomes due after `from`. A delay that is a whole number of days moves by calendar days and keeps
 * the local wall-clock time, so "2 days" stays "same time of day" across a DST change. Any other delay is an
 * exact span of minutes.
 */
export function dueAfter(from: Date, delayMinutes: number, timeZone: string): Date {
  const zone = isValidZone(timeZone) ? timeZone : "UTC";
  if (delayMinutes <= 0) return from;
  if (delayMinutes % MINUTES_PER_DAY !== 0) return new Date(from.getTime() + delayMinutes * 60_000);
  const p = parts(from, zone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + delayMinutes / MINUTES_PER_DAY));
  return instantOf({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: p.hour, minute: p.minute, second: p.second }, zone, from.getMilliseconds());
}

/** Placeholder due dates for a new run: each step comes due its own delay after the one before. Sending or skipping a step recomputes the next. */
export function planDueDates(startedAt: Date, steps: ReadonlyArray<{ position: number; delayMinutes: number }>, fromPosition: number, timeZone: string): Map<number, Date> {
  const due = new Map<number, Date>();
  let previous = startedAt;
  for (const step of [...steps].sort((a, b) => a.position - b.position)) {
    if (step.position < fromPosition) continue;
    previous = dueAfter(previous, step.delayMinutes, timeZone);
    due.set(step.position, previous);
  }
  return due;
}

// Guards the database cannot express ------------------------------------------------------------------

/** SQL checks each foreign key alone, so "this conversation belongs to this record" is the application's to prove. */
export function assertConversationBelongsToRecord(conversation: { recordId: string } | null, recordId: string): void {
  if (!conversation || conversation.recordId !== recordId) throw new ConflictError("That conversation is not part of this reply handling.");
}

/** And so is "this step belongs to the version the run is pinned to". */
export function assertStepsBelongToVersion(steps: ReadonlyArray<{ sequenceVersionId: string }>, versionId: string): void {
  if (steps.some((s) => s.sequenceVersionId !== versionId)) throw new ConflictError("A step does not belong to the version this run is pinned to.");
}

// Drafting --------------------------------------------------------------------------------------------

/** `{{firstName}}`-style merge fields. Unknown fields become empty. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => lookup.get(key.toLowerCase()) ?? "");
}

/** Extra guidance appended to the pipeline's draft instructions for one step. */
export function stepGuidance(step: { position: number; name: string; aiInstructions: string; bodyTemplate: string | null }, vars: Record<string, string | null | undefined>): string {
  const lines = [
    `## Follow-up step ${step.position}: ${step.name}`,
    step.position === 1
      ? "This step answers the lead's latest message."
      : "This step is a follow-up. The lead has not replied since our last message. Write a short nudge that adds something new instead of repeating the earlier message.",
    "",
    "Goal of this message:",
    step.aiInstructions,
  ];
  if (step.bodyTemplate) lines.push("", "Starting text to adapt, not to copy blindly:", renderTemplate(step.bodyTemplate, vars));
  return lines.join("\n");
}

export const MAX_DRAFT_ATTEMPTS = 3;
/** Back-off before a failed drafting attempt is tried again. */
export const draftRetryDelayMs = (attempts: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
