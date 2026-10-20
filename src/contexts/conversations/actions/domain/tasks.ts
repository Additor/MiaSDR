import { ValidationError } from "@/shared/errors";
import { canonicalTimeZone } from "@/shared/time-zone";

/**
 * Pure task rules: input validation, due-date handling and who may change a task.
 * A due date is a calendar day. It is stored as the last instant of that day in the caller's
 * time zone, so a task due "today" turns overdue only after the day ends where the person works.
 */

export const MAX_TASK_NAME = 200;
export const MAX_TASK_DESCRIPTION = 4000;
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 10_000;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `zone` from UTC at `at`, in milliseconds. */
function zoneOffsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The last second of the calendar day `day` (YYYY-MM-DD) in `zone`, as a UTC instant. */
export function endOfDayInZone(day: string, zone: string): Date {
  const match = DAY.exec(day);
  if (!match) throw new ValidationError("Use a due date in the form YYYY-MM-DD.");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ValidationError("That due date does not exist.");
  if (!isValidTimeZone(zone)) throw new ValidationError("Unknown time zone.");
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
  // Two passes settle the offset across a daylight-saving change.
  let instant = wall - zoneOffsetMs(zone, new Date(wall));
  instant = wall - zoneOffsetMs(zone, new Date(instant));
  return new Date(instant);
}

/** The calendar day (YYYY-MM-DD) that `at` falls on in `zone`. */
export function dayInZone(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface TaskInput {
  name: string;
  description: string | null;
  /** YYYY-MM-DD, or null for no due date. */
  dueDay: string | null;
  timeZone: string;
}

export function parseTaskInput(input: { name: string; description?: string | null; dueDay?: string | null; timeZone?: string | null }): TaskInput {
  const name = input.name.trim();
  if (name === "" || name.length > MAX_TASK_NAME) throw new ValidationError(`The task name must be 1 to ${MAX_TASK_NAME} characters.`);
  const description = input.description?.trim() || null;
  if (description && description.length > MAX_TASK_DESCRIPTION) throw new ValidationError(`The description is longer than ${MAX_TASK_DESCRIPTION} characters.`);
  const timeZone = canonicalTimeZone(input.timeZone?.trim() || "UTC");
  if (!timeZone) throw new ValidationError("Unknown time zone.");
  const dueDay = input.dueDay?.trim() || null;
  if (dueDay) endOfDayInZone(dueDay, timeZone);
  return { name, description, dueDay, timeZone };
}

export interface TaskActor {
  userId: string;
  role: string;
}

/** A member changes tasks they created or hold. Owners and admins change any task. */
export function canChangeTask(actor: TaskActor, isAdmin: boolean, task: { createdBy: string | null; assigneeId: string | null }): boolean {
  return isAdmin || task.createdBy === actor.userId || task.assigneeId === actor.userId;
}

/** A member edits or deletes only their own notes. Owners and admins change any note. */
export function canChangeNote(actor: TaskActor, isAdmin: boolean, note: { createdBy: string | null }): boolean {
  return isAdmin || note.createdBy === actor.userId;
}

/** Overdue first (oldest due date first), then due soon, then no due date; completed tasks last. */
export function compareTasks(a: { isCompleted: boolean; dueAt: Date | null; createdAt: Date }, b: { isCompleted: boolean; dueAt: Date | null; createdAt: Date }): number {
  if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
  if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
