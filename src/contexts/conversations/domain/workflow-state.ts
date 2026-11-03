import type { ReplyTypeDecision } from "./reply-type";

/**
 * Where a conversation's reply handling stands (`conversations.workflow_state`). Mirrors the `conversations_workflow_ck` check.
 *
 * - `no_type`: no reply has landed yet, so the conversation has no reply type.
 * - `action_required`: a person has something to do (a draft to approve, a pick to review, a reply to answer).
 * - `waiting`: a reply went out and a follow-up is due at `next_action_at`.
 * - `idle`: nothing is due.
 * - `closed`: a person closed it. It reopens only on a new inbound message or Reopen.
 *
 * The functions below are the transitions a store decides from the row it locked. Three more are written in SQL, because
 * they must hold against a concurrent writer: an inbound message (not an auto-reply) sets `action_required` from any
 * state; a sent reply sets `waiting` only while the context version it was drafted on still holds; a follow-up draft
 * moves `waiting` or `idle` to `action_required`, and an ended follow-up run moves `waiting` to `idle`.
 */
export const WORKFLOW_STATES = ["no_type", "action_required", "waiting", "idle", "closed"] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** A person rejects an AI pick or marks the person do not contact: open work comes back to someone, a closed one stays closed. */
export const afterPersonDecision = (current: string): WorkflowState => (current === "closed" ? "closed" : "action_required");

/** Reopen goes back to work when a reply waits, else rests. */
export const afterReopen = (hasInbound: boolean): WorkflowState => (hasInbound ? "action_required" : "idle");

/**
 * A person changes the reply type. A type whose decision wants a draft brings resting handling to `action_required`; one that does not lets `action_required` rest at `idle`. Every other state stays.
 */
export function afterTypeChange(current: WorkflowState, decision: Pick<ReplyTypeDecision, "wantsDraft">): WorkflowState {
  if (decision.wantsDraft) return current === "idle" || current === "no_type" ? "action_required" : current;
  return current === "action_required" ? "idle" : current;
}

/**
 * An applied AI pick settles `action_required` to `idle` when nothing is left for a person: the pick did not wait, it
 * wants no draft, and the reply asked nothing to stop.
 */
export const settlesAfterAiPick = (current: string, decision: ReplyTypeDecision, stopRequested: boolean): boolean =>
  current === "action_required" && decision.hold === null && !decision.wantsDraft && !stopRequested;
