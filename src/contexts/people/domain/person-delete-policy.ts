/*
 * The person delete policy ("Delete" and "Contact delete" in docs/decisions.md). Two modes share one lock order and one set
 * of safety rules: a send in flight, an AI job at work on the person's replies, and another member's personal campaign that
 * the actor cannot see.
 *
 * Lead mode (bulk and single lead delete) refuses a lead with any history and removes only what never reached the person:
 * a counted send (`sending`, `sent` or `unknown`), a live enrollment in an active or paused campaign, a reply-handling
 * record or an event, or `lifecycle = 'contact'`. A send in flight is a counted send, and an AI job needs a record, so two of
 * the safety rules fall inside the history rule here. A lead whose sends all failed goes, with those sends.
 *
 * Contact mode purges the history and stops only at the safety rules, open deals and the recent-send windows. Outreach owns
 * those windows (`RECENT_SEND_MS`), so its port answers with the blockers it found and this module merges them.
 */

/**
 * Why a lead stays. `has_hidden_sends`: `has_sends` where every send is in a personal campaign of another member, which the
 * viewer cannot see. `personal_campaign_sends`: for a member, an enrollment in a personal campaign another member created,
 * sent or not. `try_again`: the batch met a concurrent change (a lock timeout twice, the statement timeout, or a row that
 * appeared after the locks) and rolled back.
 */
export type BlockReason = "has_sends" | "has_hidden_sends" | "personal_campaign_sends" | "in_active_campaign" | "linked_records" | "try_again";

/** What the outreach port reports for one lead. Outreach decides visibility and campaign state; the policy only ranks them. */
export type LeadOutreachBlocker = "has_sends" | "has_hidden_sends" | "personal_campaign_sends" | "in_active_campaign";

export interface LeadDeleteFacts {
  /** `lifecycle = 'contact'`. A contact has its own delete. */
  contact: boolean;
  /** A reply-handling record or an event of the person (conversations). */
  history: boolean;
  outreach: readonly LeadOutreachBlocker[];
}

/**
 * First matching reason wins. Reasons that keep the lead for every actor rank first, so the reason a person reads holds
 * for whoever they ask. `personal_campaign_sends` keeps it from this member only, so it shows when nothing else applies.
 */
const LEAD_ORDER: readonly BlockReason[] = ["has_sends", "has_hidden_sends", "in_active_campaign", "linked_records", "personal_campaign_sends"];

/** The reason a lead stays, or null when lead mode deletes it. */
export function leadDeleteBlock(facts: LeadDeleteFacts): BlockReason | null {
  // A contact always has events (the conversion writes one); a contact inserted without history stays undeletable too.
  const found: readonly BlockReason[] = facts.history || facts.contact ? [...facts.outreach, "linked_records"] : facts.outreach;
  return LEAD_ORDER.find((reason) => found.includes(reason)) ?? null;
}

/** Contact mode: every blocker of the contexts in one list, in the order given, with `send_in_flight` named once. */
export function mergeContactBlockers<B extends { reason: string }>(...lists: ReadonlyArray<readonly B[]>): B[] {
  const all = lists.flat();
  return all.filter((blocker, index) => blocker.reason !== "send_in_flight" || all.findIndex((b) => b.reason === "send_in_flight") === index);
}
