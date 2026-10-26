/**
 * Where a conversation's reply handling stands (`records.workflow_state`). Mirrors the `records_workflow_ck` check.
 *
 * - `unclassified`, `classifying`: a reply waits for its category.
 * - `action_required`: a person has something to do (a draft to approve, a category to review, a reply to answer).
 * - `waiting`: a reply went out and a follow-up is due at `next_action_at`.
 * - `idle`: nothing is due. `paused`: a person paused the work. `error`: the last job failed.
 * - `closed`: a person closed it. It reopens only on a new inbound message or Reopen.
 *
 * The functions below are the transitions a store decides from the row it locked. Three more are written in SQL, because
 * they must hold against a concurrent writer: an inbound message (not an auto-reply) sets `action_required` from any
 * state; a sent reply sets `waiting` only while the context version it was drafted on still holds; a follow-up draft
 * moves `waiting` or `idle` to `action_required`, and an ended follow-up run moves `waiting` to `idle`.
 */
export const WORKFLOW_STATES = ["unclassified", "classifying", "action_required", "waiting", "idle", "paused", "closed", "error"] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** A person rejects a classification or marks the person do not contact: open work comes back to someone, a closed one stays closed. */
export const afterPersonDecision = (current: string): WorkflowState => (current === "closed" ? "closed" : "action_required");

/** Reopen goes back to work when a reply waits, else rests. */
export const afterReopen = (hasInbound: boolean): WorkflowState => (hasInbound ? "action_required" : "idle");

/**
 * A person sets the category by hand. One that wants a draft brings resting or failed handling to `action_required`; one
 * that does not lets `action_required` rest at `idle`. Every other state stays.
 */
export function afterManualCategory(current: WorkflowState, wantsDraft: boolean): WorkflowState {
  if (wantsDraft) return current === "idle" || current === "error" || current === "unclassified" ? "action_required" : current;
  return current === "action_required" ? "idle" : current;
}

/** An applied AI category settles `action_required` to `idle` when it wants no draft and the reply asked nothing to stop. */
export const settlesAfterAiCategory = (current: string, input: { wantsDraft: boolean; stopRequested: boolean }): boolean =>
  !input.wantsDraft && !input.stopRequested && current === "action_required";
