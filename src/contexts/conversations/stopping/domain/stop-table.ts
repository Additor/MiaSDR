import type { OutreachHalt } from "@/contexts/outreach/domain/enrollment-status";
import type { SuppressionReason } from "@/contexts/people/domain/reachability";
import type { InterruptReason } from "../../after-reply/domain/follow-ups";

/**
 * Everything that stops contact with a person goes through `stopContactTx` (`../infrastructure/stop-contact.ts`), and this
 * table says what each trigger ends. A difference between two rows is a behavior someone relies on or a gap someone should
 * read, so a new trigger gets its own row. `stop-contact.integration.test.ts` walks the table against real rows.
 */
export const STOP_TRIGGERS = ["reply", "bounce", "unsubscribe", "suppression", "sender_suppressed", "do_not_contact", "conversion"] as const;
export type StopTriggerKind = (typeof STOP_TRIGGERS)[number];

export type ChannelReach = "every_channel" | "email_only";

export interface StopRow {
  /**
   * Whom it reaches. `person`: the person named. `person_and_sender`: also anyone in the organization with the sender's
   * address. `address_owners`: every person in the organization with the address.
   */
  people: "person" | "person_and_sender" | "address_owners";
  /** The `suppression_list` reason people's writer stores first, or null when the trigger adds no entry. */
  suppressionReason: SuppressionReason | null;
  /** People's writer sets `contact_policies.do_not_contact` first. Nothing else happens when the flag was already set. */
  marksDoNotContact: boolean;
  /**
   * Which live enrollments of the people reached end, in every campaign. `email_only` leaves LinkedIn open: a bounce is a
   * fact about an address. `every_channel`: the person or a teammate wants contact stopped.
   */
  enrollments: ChannelReach;
  /** The enrollment status and `stop_reason` (`haltOutcome`). */
  halt: OutreachHalt;
  /** Which active and paused runs of the people reached end. A run's channel is its thread's. */
  runs: ChannelReach;
  /** The reason stored on each ended run. */
  runReason: InterruptReason;
  /**
   * Which drafts retire. `run_drafts`: the unsent drafts of the ended runs. `run_drafts_and_review`: also the conversation's
   * drafts in `awaiting_review`. `all_open`: every retirable draft of every conversation of the person.
   */
  drafts: "run_drafts" | "run_drafts_and_review" | "all_open";
  /** The `error` a retired non-run draft carries. A run's drafts carry the run's own message (`endRunCountingTx`). */
  draftError: string | null;
  /**
   * Every conversation of the person bumps its context, returns to a person (`afterPersonDecision`), loses its next
   * action and counts as a person's stop review.
   */
  settlesConversations: boolean;
  /** The event `stopContactTx` writes for the person or the conversation. Null: it writes none, or the caller writes its own. */
  eventType: string | null;
  /** The event written for each settled conversation. */
  conversationEventType: string | null;
}

const ADDRESS_STOP = {
  people: "address_owners",
  marksDoNotContact: false,
  enrollments: "every_channel",
  runs: "every_channel",
  drafts: "run_drafts",
  draftError: null,
  settlesConversations: false,
  eventType: null,
  conversationEventType: null,
} as const;

export const STOP_TABLE: Record<StopTriggerKind, StopRow> = {
  reply: {
    people: "person_and_sender",
    suppressionReason: null,
    marksDoNotContact: false,
    enrollments: "every_channel",
    halt: "replied",
    runs: "every_channel",
    runReason: "reply",
    drafts: "run_drafts",
    draftError: null,
    settlesConversations: false,
    eventType: "outreach.stopped_by_reply",
    conversationEventType: null,
  },
  bounce: { ...ADDRESS_STOP, suppressionReason: "bounced", enrollments: "email_only", halt: "bounced", runs: "email_only", runReason: "bounce" },
  unsubscribe: { ...ADDRESS_STOP, suppressionReason: "unsubscribed", halt: "unsubscribed", runReason: "unsubscribed" },
  suppression: { ...ADDRESS_STOP, suppressionReason: "manual", halt: "manual", runReason: "suppressed" },
  sender_suppressed: {
    ...ADDRESS_STOP,
    suppressionReason: "unsubscribed",
    halt: "unsubscribed",
    runReason: "unsubscribed",
    drafts: "run_drafts_and_review",
    draftError: "The sender was suppressed.",
    eventType: "contact.suppressed",
  },
  do_not_contact: {
    people: "person",
    suppressionReason: null,
    marksDoNotContact: true,
    enrollments: "every_channel",
    halt: "do_not_contact",
    runs: "every_channel",
    runReason: "do_not_contact",
    drafts: "all_open",
    draftError: "The person was marked do not contact.",
    settlesConversations: true,
    eventType: "contact_policy.dnc_set",
    conversationEventType: "contact_policy.enforced",
  },
  conversion: {
    people: "person",
    suppressionReason: null,
    marksDoNotContact: false,
    enrollments: "every_channel",
    halt: "converted",
    runs: "every_channel",
    runReason: "converted",
    drafts: "run_drafts",
    draftError: null,
    settlesConversations: false,
    eventType: null,
    conversationEventType: null,
  },
};
