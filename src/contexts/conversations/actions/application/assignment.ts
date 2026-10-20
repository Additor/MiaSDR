import { NotFoundError, type Actor } from "@/shared/errors";

/**
 * Who handles the replies of a reply-handling record. Any member of the organization may take an unassigned conversation
 * or give any conversation they can see to another member ("Actions work queue" in docs/decisions.md). Another
 * organization's ids answer 404, as an id that is not a UUID does. Nothing here sends a message, changes the context
 * version or retires a draft: an assignment is not a reclassification.
 */

export type AssignmentChange = { kind: "claim" } | { kind: "assign"; target: string | null; expected: string | null };

export interface AssignmentResult {
  recordId: string;
  assignedTo: string | null;
  previousAssignedTo: string | null;
  changed: boolean;
}

export interface AssignmentStore {
  /** Locks the visible record, applies the domain plan and writes the event. Throws NotFound, Conflict or Validation. */
  change(input: { organizationId: string; recordId: string; actorUserId: string; change: AssignmentChange; now: Date }): Promise<AssignmentResult>;
}

export interface AssignmentDeps {
  store: AssignmentStore;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id: string) => {
  if (!UUID.test(id)) throw new NotFoundError("Reply handling not found");
};

/** Takes an unassigned conversation. Taking one you already hold changes nothing; one someone else holds answers 409. */
export async function claimRecord(deps: AssignmentDeps, actor: Actor, recordId: string) {
  assertId(recordId);
  return deps.store.change({ organizationId: actor.organizationId, recordId, actorUserId: actor.userId, change: { kind: "claim" }, now: deps.now() });
}

/**
 * Gives the conversation to a member, or to nobody with a null `assignedTo`. `expectedAssignedTo` is who the person saw
 * holding it; a different holder answers 409. A target who is not a member answers 422.
 */
export async function assignRecord(deps: AssignmentDeps, actor: Actor, recordId: string, input: { assignedTo: string | null; expectedAssignedTo: string | null }) {
  assertId(recordId);
  return deps.store.change({
    organizationId: actor.organizationId,
    recordId,
    actorUserId: actor.userId,
    change: { kind: "assign", target: input.assignedTo, expected: input.expectedAssignedTo },
    now: deps.now(),
  });
}
