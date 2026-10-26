import { cache } from "react";
import { getNextQueueItem } from "@/contexts/conversations/actions/application/work-queue";
import type { QueueItem } from "@/contexts/conversations/actions/application/work-queue-ports";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { ValidationError, type Actor } from "@/shared/errors";
import { personHref } from "@/app/(app)/_components/person/person-href";
import { threadQueryFromActions } from "@/app/(app)/actions/actions-query";

export interface NextInQueue {
  /** Where the next item opens, carrying the view so the step after it works the same way. */
  href: string;
  name: string;
}

/**
 * The item after this record in the queue view the thread was opened from, or null when nothing else waits, or undefined when
 * the view in the URL does not parse (a made-up scope, a date that is not a day), so the thread simply leaves the step out.
 * The header link and the reply panel both ask for it, and React runs the read once per request because they pass the same
 * `actor` and `view` objects.
 */
export const loadNextInQueue = cache(async (actor: Actor, recordId: string, view: Record<string, string>): Promise<NextInQueue | null | undefined> => {
  let next: QueueItem | null;
  try {
    next = await getNextQueueItem(workQueueDeps(), actor, { recordId, filter: view });
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
  if (!next) return null;
  return {
    href: next.conversationId ? `/inbox/${next.conversationId}?${threadQueryFromActions(view)}` : personHref(next.personId, next.personLifecycle),
    name: next.personName ?? "the next person",
  };
});
