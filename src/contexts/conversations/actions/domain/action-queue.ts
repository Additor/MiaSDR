import { ValidationError } from "@/shared/errors";
import { isCalendarDay, shiftDay, startOfDayInZone } from "@/shared/time-zone";

/**
 * The Actions queue lists records, not source rows. A record is in the queue when it is `action_required`
 * or `error`, or `waiting` with `next_action_at` due. Each one sits in exactly one group, picked in this
 * order: problem, reply, classification, follow_up, next_step. The page lists the groups in `QUEUE_GROUPS` order, problems
 * first: a draft that failed or a send that may not have gone out outranks the rest, whatever its age.
 */
export const QUEUE_GROUPS = ["problem", "reply", "follow_up", "classification", "next_step"] as const;
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

export const isQueueGroup = (value: string): value is QueueGroup => (QUEUE_GROUPS as readonly string[]).includes(value);

export const QUEUE_GROUP_LABELS: Record<QueueGroup, { title: string; description: string }> = {
  reply: { title: "Replies to approve", description: "Drafts waiting for your review. Nothing is sent until you approve." },
  follow_up: { title: "Follow-ups due", description: "Leads you waited on who are due another touch." },
  classification: { title: "Classifications to review", description: "AI suggestions to decide, and changes it applied that you have not looked at." },
  next_step: { title: "Needs a next step", description: "Nothing is drafted or classified yet. Write a reply, change the reply category or add a task." },
  problem: { title: "Problems", description: "A draft or AI job failed, a send is unconfirmed, or reply handling hit an error." },
};

/**
 * What the queue knows about one visible record. Each flag is true when the thing exists and applies: a failed or
 * unconfirmed draft, a failed AI job that no newer draft answers, a draft awaiting review, a held or unseen
 * classification, an open task. The SQL in `work-queue-read.ts` computes the same facts; `queueGroupOf` and `isInQueue`
 * are the rule, and `action-queue.integration.test.ts` checks that the query agrees with them.
 */
export interface QueueFacts {
  workflowState: string;
  nextActionAt: Date | null;
  hasProblemDraft: boolean;
  hasFailedJob: boolean;
  hasDraftToReview: boolean;
  hasReplyTypePickToReview: boolean;
  hasOpenTask: boolean;
}

/** The first match of problem, reply, classification, follow_up, next_step. */
export function queueGroupOf(facts: QueueFacts): QueueGroup {
  if (facts.workflowState === "error" || facts.hasProblemDraft || facts.hasFailedJob) return "problem";
  if (facts.hasDraftToReview) return "reply";
  if (facts.hasReplyTypePickToReview) return "classification";
  if (facts.workflowState === "waiting") return "follow_up";
  return "next_step";
}

/**
 * A record is in the queue when it is `action_required` or `error`, or `waiting` with `next_action_at` due. A `next_step`
 * record with an open task is left out, because the task already puts it in front of a person.
 */
export function isInQueue(facts: QueueFacts, now: Date): boolean {
  const due = facts.workflowState === "waiting" && facts.nextActionAt !== null && facts.nextActionAt.getTime() <= now.getTime();
  if (facts.workflowState !== "action_required" && facts.workflowState !== "error" && !due) return false;
  return !(queueGroupOf(facts) === "next_step" && facts.hasOpenTask);
}

/**
 * Why the clock of a queue item started. `inbound`: the last message from the other side (reply, classification, next_step).
 * `failure`: when the failure was recorded (problem). `due`: when a follow-up came due (follow_up), shown as "overdue since".
 * Only `inbound` and `failure` say how long a person on the other side has waited or a send has been stuck.
 */
export type WaitingBasis = "inbound" | "failure" | "due";

export interface WaitingSince {
  at: Date;
  basis: WaitingBasis;
}

export interface WaitingFacts {
  lastInboundAt: Date | null;
  lastInteractionAt: Date | null;
  createdAt: Date;
  nextActionAt: Date | null;
  /** When the failure was recorded: the failed draft's last update, the failed job's failure time, or the record's last update. */
  failedAt: Date;
}

/** The clock of an item in `group`. Items inside a group are listed by it, oldest first. */
export function waitingSince(group: QueueGroup, facts: WaitingFacts): WaitingSince {
  const inbound = facts.lastInboundAt ?? facts.lastInteractionAt ?? facts.createdAt;
  if (group === "problem") return { at: facts.failedAt, basis: "failure" };
  if (group === "follow_up") return { at: facts.nextActionAt ?? inbound, basis: "due" };
  return { at: inbound, basis: "inbound" };
}

/** Everything the Actions page can show as work. Each number counts items that wait on a person. */
export interface WorkTotals {
  /** Records in the queue, all groups. */
  queue: number;
  /** Open tasks, assigned or not. */
  tasks: number;
  uncertainCampaignSends: number;
  unmatchedSenders: number;
  /** Dead inbound events. Zero for a member who cannot see them. */
  deadLetters: number;
}

/** True only when no source holds work. A page says "nothing waits" on this and on nothing less. */
export function isWorkClear(totals: WorkTotals): boolean {
  return totals.queue + totals.tasks + totals.uncertainCampaignSends + totals.unmatchedSenders + totals.deadLetters === 0;
}

/**
 * The item to open after `currentRecordId`, given candidates in the order they should win. The first one that is not the
 * current record wins. The open item never qualifies. `getNextQueueItem` builds the candidates: the next item of the same
 * group, then the first items of the other groups (`groupsAfter`), and for a record that left the queue the top of the queue.
 */
export function pickNextQueueItem<T extends { recordId: string }>(candidates: readonly T[], currentRecordId: string): T | null {
  return candidates.find((item) => item.recordId !== currentRecordId) ?? null;
}

/**
 * The groups in the order a search for "the next item" visits them after the item in `group`: the groups below it in display
 * order, then the groups above it (the queue wraps), then `group` itself for the items above the current one.
 */
export function groupsAfter(group: QueueGroup): QueueGroup[] {
  const at = QUEUE_GROUPS.indexOf(group);
  return [...QUEUE_GROUPS.slice(at + 1), ...QUEUE_GROUPS.slice(0, at), group];
}

export const QUEUE_DEFAULT_LIMIT = 50;
export const QUEUE_MAX_LIMIT = 200;

/**
 * Whose work a queue item is. The three scopes split the queue by assignee and do not overlap: a record is mine when I am
 * its assignee, unassigned when it has none, and someone else's otherwise.
 */
export const QUEUE_SCOPES = ["mine", "unassigned", "others"] as const;
export type QueueScope = (typeof QUEUE_SCOPES)[number];

export const isQueueScope = (value: string): value is QueueScope => (QUEUE_SCOPES as readonly string[]).includes(value);

export function scopeOf(assignedTo: string | null, actorUserId: string): QueueScope {
  if (assignedTo === null) return "unassigned";
  return assignedTo === actorUserId ? "mine" : "others";
}

export type QueueProblemKind = "record_error" | "draft_failed" | "delivery_uncertain" | "job_failed";

export interface QueueFilter {
  /** A category key, or `unclassified`. */
  groupKey?: string;
  channel?: string;
  group?: QueueGroup;
  /** Whose items to show. Without it the whole queue shows. */
  scope?: QueueScope;
  replyTypeId?: string;
  /** Records of people currently enrolled in this campaign (email or LinkedIn, any status but removed). It does not mean the campaign that owns the conversation. */
  campaignId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  /** Shows the problem group only. */
  errorsOnly?: boolean;
}

/**
 * Position of the last item of a group page: its waiting time as Postgres printed it (microseconds survive) and the record id.
 * The first element of the encoded cursor is the order it belongs to. A group is read oldest first (`w`); a cursor from the
 * newest-first order is refused, because continuing it would skip or repeat items.
 */
export interface QueueCursor {
  sortKey: string;
  recordId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORT_KEY = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?)?$/;

const CURSOR_ORDER = "w";

export const encodeQueueCursor = (cursor: QueueCursor) => Buffer.from(JSON.stringify([CURSOR_ORDER, cursor.sortKey, cursor.recordId])).toString("base64url");

export function decodeQueueCursor(value: string): QueueCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === CURSOR_ORDER &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      SORT_KEY.test(parsed[1]) &&
      UUID.test(parsed[2])
    ) {
      return { sortKey: parsed[1], recordId: parsed[2] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ValidationError("The cursor is not valid. Reload the queue.");
}

export function clampQueueLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return QUEUE_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), QUEUE_MAX_LIMIT);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare date is a calendar day in `timeZone`. As a lower bound it means the start of that day. As an upper bound it means
 * the end of that day, so "due before Oct 15" includes Oct 15. A full timestamp is taken as it is.
 */
function parseDate(value: unknown, label: string, timeZone: string, endOfDay = false): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError(`${label} is not a valid date.`);
    return value;
  }
  const text = String(value);
  if (DATE_ONLY.test(text)) {
    if (!isCalendarDay(text)) throw new ValidationError(`${label} is not a valid date.`);
    return endOfDay ? new Date(startOfDayInZone(shiftDay(text, 1), timeZone).getTime() - 1) : startOfDayInZone(text, timeZone);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} is not a valid date.`);
  return date;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/**
 * Validates raw query values. Ids must be UUIDs, so a bad value answers 422, not a database error. A bare date reads as a
 * day in `timeZone` (the organization's zone; UTC when none is given). `campaignId` keeps
 * people currently enrolled in that campaign (any enrollment status but removed, email or LinkedIn). It does not select the
 * campaign that owns the conversation.
 */
export function parseQueueFilter(raw: Record<string, unknown>, timeZone = "UTC"): QueueFilter {
  const filter: QueueFilter = {};
  const category = text(raw.category);
  if (category) filter.groupKey = category;
  const channel = text(raw.channel);
  if (channel) {
    if (channel !== "email" && channel !== "linkedin") throw new ValidationError("Channel must be email or linkedin.");
    filter.channel = channel;
  }
  const group = text(raw.group);
  if (group) {
    if (!isQueueGroup(group)) throw new ValidationError(`Action type must be one of ${QUEUE_GROUPS.join(", ")}.`);
    filter.group = group;
  }
  const scope = text(raw.scope);
  if (scope) {
    if (!isQueueScope(scope)) throw new ValidationError(`Scope must be one of ${QUEUE_SCOPES.join(", ")}.`);
    filter.scope = scope;
  }
  for (const [key, label] of [["replyTypeId", "Subcategory"], ["campaignId", "Campaign"]] as const) {
    const id = text(raw[key]);
    if (id) {
      if (!UUID.test(id)) throw new ValidationError(`${label} is not a valid id.`);
      filter[key] = id;
    }
  }
  filter.dueBefore = parseDate(raw.dueBefore, "Due before", timeZone, true);
  filter.dueAfter = parseDate(raw.dueAfter, "Due after", timeZone);
  if (filter.dueBefore === undefined) delete filter.dueBefore;
  if (filter.dueAfter === undefined) delete filter.dueAfter;
  if (raw.errorsOnly === true || raw.errorsOnly === "1" || raw.errorsOnly === "true") {
    if (filter.group && filter.group !== "problem") throw new ValidationError("Errors only cannot combine with another action type.");
    filter.errorsOnly = true;
  }
  return filter;
}
