import { ConflictError, ValidationError } from "@/shared/errors";

/**
 * Who handles the replies of a reply-handling record. Pure rules; the store reads the locked row and the membership and
 * applies the plan. The assignee is a member of the organization or nobody. It is not the deal's owner and not a task's
 * assignee.
 */

/**
 * How `assigned_to` got its value. `auto` is the campaign creator on the first inbound message (or the backfill), `human` is a
 * person who took or gave the conversation, and `cleared` is a person who chose Nobody. `cleared` keeps the next inbound message
 * from handing the conversation back to the campaign creator: a person's choice is never replaced, and Nobody is a choice.
 */
export const ASSIGNED_SOURCES = ["auto", "human", "cleared"] as const;
export type AssignedSource = (typeof ASSIGNED_SOURCES)[number];

/** The `events.event_type` of every change. The mover is the actor; an automatic assignment has the actor type `system`. */
export const ASSIGNED_EVENT = "assignee.changed";

export interface AssigneeCandidate {
  userId: string;
  /** True while the user is still a member of the record's organization. */
  isMember: boolean;
}

/**
 * The first candidate who is still a member. Candidates arrive newest first: the creators of the person's campaigns, newest
 * enrollment first. A creator who left is skipped, not a reason to leave the record unassigned.
 */
export function pickAssignee(candidates: readonly AssigneeCandidate[]): string | null {
  return candidates.find((c) => c.isMember)?.userId ?? null;
}

export type AssignmentPlan = { changed: false; assignedTo: string | null } | { changed: true; assignedTo: string | null; source: AssignedSource; from: string | null };

/** Taking an unassigned conversation. Taking one you already hold changes nothing. Taking one someone else holds is refused. */
export function planClaim(current: string | null, actorUserId: string): AssignmentPlan {
  if (current === actorUserId) return { changed: false, assignedTo: current };
  if (current !== null) throw new ConflictError("Another member already handles this conversation.");
  return { changed: true, assignedTo: actorUserId, source: "human", from: null };
}

/**
 * Giving a conversation to a member, or to nobody. `expected` is the assignee the person saw. When another change landed
 * first the plan is refused, so two people never overwrite each other unseen.
 */
export function planAssign(input: { current: string | null; expected: string | null; target: string | null; targetIsMember: boolean }): AssignmentPlan {
  if (input.expected !== input.current) throw new ConflictError("This conversation was reassigned while you were looking at it. Reload to see who handles it.");
  if (input.target !== null && !input.targetIsMember) throw new ValidationError("Choose a member of this organization.");
  if (input.target === input.current) return { changed: false, assignedTo: input.current };
  return { changed: true, assignedTo: input.target, source: input.target === null ? "cleared" : "human", from: input.current };
}
