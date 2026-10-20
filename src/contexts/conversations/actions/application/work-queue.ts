import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { QUEUE_GROUPS, clampQueueLimit, decodeQueueCursor, groupsAfter, parseQueueFilter, pickNextQueueItem } from "../domain/action-queue";
import type { QueueItem, WorkQueueStore } from "./work-queue-ports";

/**
 * The work queue: records, and the work around them, that wait on a person. Any member of the organization may read it
 * (decisions.md, "AI replies"). Every store call carries the actor's organization, so another organization's ids answer 404.
 *
 * Nothing here sends a message. Drafts are approved and sent only through `approveAndSendDraft`.
 */

export interface WorkQueueDeps {
  store: WorkQueueStore;
  /** The organization's time zone. A bare date in a filter is a day in it; UTC when this is not wired. */
  timeZone?: (organizationId: string) => Promise<string>;
}

const BARE_DATES = ["dueBefore", "dueAfter"] as const;

/** Reads the zone only when a filter holds a due date, the one place a zone matters. */
async function filterFor(deps: WorkQueueDeps, actor: Actor, raw: Record<string, unknown> | undefined) {
  const needsZone = BARE_DATES.some((key) => raw?.[key] !== undefined && raw[key] !== null && raw[key] !== "");
  const zone = needsZone && deps.timeZone ? await deps.timeZone(actor.organizationId) : "UTC";
  return parseQueueFilter(raw ?? {}, zone);
}

export interface ActionQueueInput {
  /** Raw filter values, as they arrive in a query string. */
  filter?: Record<string, unknown>;
  limit?: unknown;
  cursor?: string | null;
}

/**
 * One page of the work queue. Without a cursor, every group returns its first page. With one, `filter.group`
 * is required and only that group returns its next page. Totals are exact for the filter.
 */
export async function getWorkQueue(deps: WorkQueueDeps, actor: Actor, input: ActionQueueInput = {}) {
  const filter = await filterFor(deps, actor, input.filter);
  const cursor = input.cursor ? decodeQueueCursor(input.cursor) : null;
  if (cursor && !filter.group && !filter.errorsOnly) throw new ValidationError("A cursor needs an action type.");
  if (filter.errorsOnly) filter.group = "problem";
  return deps.store.actionQueue(actor.organizationId, { actorUserId: actor.userId, filter, limit: clampQueueLimit(input.limit), cursor });
}

export const getWorkQueueCounts = (deps: WorkQueueDeps, actor: Actor) => deps.store.actionQueueCounts(actor.organizationId, actor.userId);

export const getWorkQueueExtras = (deps: WorkQueueDeps, actor: Actor) => deps.store.actionQueueExtras(actor.organizationId);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The item to open after the one the person is on, under the filter they came from, in display order: the next item of the
 * same group, then the first items of the groups below it, then the groups above it. A record that has left the queue (it was
 * just handled, or the filter no longer holds it) has no place, so the answer is the top of the queue. The position is read
 * with a keyset cursor, so it does not matter how far down the group the record sits. Null when nothing else waits.
 */
export async function getNextQueueItem(deps: WorkQueueDeps, actor: Actor, input: { recordId: string; filter?: Record<string, unknown> }): Promise<QueueItem | null> {
  if (!UUID.test(input.recordId)) throw new NotFoundError("Reply handling not found");
  const filter = await filterFor(deps, actor, input.filter);
  if (filter.errorsOnly) filter.group = "problem";
  const org = actor.organizationId;
  const position = await deps.store.queuePosition(org, { actorUserId: actor.userId, filter, recordId: input.recordId });
  // Two items per group are enough: the current one can be the first of its own group, never more than one of the two.
  const tops = await deps.store.actionQueue(org, { actorUserId: actor.userId, filter, limit: 2, cursor: null });
  if (!position) return pickNextQueueItem(QUEUE_GROUPS.flatMap((g) => tops.groups[g].items), input.recordId);
  const below = await deps.store.actionQueue(org, { actorUserId: actor.userId, filter: { ...filter, group: position.group }, limit: 1, cursor: position.cursor });
  return pickNextQueueItem([...below.groups[position.group].items, ...groupsAfter(position.group).flatMap((g) => tops.groups[g].items)], input.recordId);
}
