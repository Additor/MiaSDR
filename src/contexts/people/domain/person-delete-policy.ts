/*
 * The person delete policy ("Delete" and "Contact delete" in docs/decisions.md). Two modes share one lock order and one set
 * of safety rules: a send in flight and an AI job at work on the person's replies.
 *
 * Lead mode (bulk and single lead delete) refuses a lead with any history and removes only what never reached the person:
 * a counted send (`sending`, `sent` or `unknown`), a live enrollment in an active or paused campaign, a conversation
 * or an event, or `lifecycle = 'contact'`. A send in flight is a counted send, and an AI job needs a conversation, so two of
 * the safety rules fall inside the history rule here. A lead whose sends all failed goes, with those sends.
 *
 * Contact mode purges the history and stops only at the safety rules, open deals and the recent-send windows. Outreach owns
 * those windows (`RECENT_SEND_MS`), so its port answers with the blockers it found and this module merges them.
 */

/**
 * Why a lead stays. `try_again`: the batch met a concurrent change (a lock timeout twice, the statement timeout, or a row that
 * appeared after the locks) and rolled back. `agent_delete_protected`: an agent asked, and the delete would erase a signal
 * that this person stays out of reach (`AGENT_DELETE_PROTECTED`).
 */
export type BlockReason = "has_sends" | "in_active_campaign" | "linked_conversations" | "try_again" | "agent_delete_protected";

/**
 * Deleting a person can undo a promise to leave them alone: without an email, the do not contact mark goes with them, and
 * a stop request or a removal from a campaign goes in any case. A later import then treats them as new. So an agent
 * never deletes someone marked do not contact, on the suppression list, who asked to stop, or who was removed from a
 * campaign. A person can, after reading what it erases.
 */
export const AGENT_DELETE_PROTECTED = "This person is marked do not contact, on the suppression list, asked to stop, or was removed from a campaign. Only a person deletes them, in MiaSDR.";

/** What the outreach port reports for one lead. Outreach reads the sends and campaign state; the policy only ranks them. */
export type LeadOutreachBlocker = "has_sends" | "in_active_campaign";

export interface LeadDeleteFacts {
  /** `lifecycle = 'contact'`. A contact has its own delete. */
  contact: boolean;
  /** A conversation or an event of the person. */
  history: boolean;
  outreach: readonly LeadOutreachBlocker[];
}

/** First matching reason wins. */
const LEAD_ORDER: readonly BlockReason[] = ["has_sends", "in_active_campaign", "linked_conversations"];

/** The reason a lead stays, or null when lead mode deletes it. */
export function leadDeleteBlock(facts: LeadDeleteFacts): BlockReason | null {
  // A contact always has events (the conversion writes one); a contact inserted without history stays undeletable too.
  const found: readonly BlockReason[] = facts.history || facts.contact ? [...facts.outreach, "linked_conversations"] : facts.outreach;
  return LEAD_ORDER.find((reason) => found.includes(reason)) ?? null;
}

/** Contact mode: every blocker of the contexts in one list, in the order given, with `send_in_flight` named once. */
export function mergeContactBlockers<B extends { reason: string }>(...lists: ReadonlyArray<readonly B[]>): B[] {
  const all = lists.flat();
  return all.filter((blocker, index) => blocker.reason !== "send_in_flight" || all.findIndex((b) => b.reason === "send_in_flight") === index);
}
