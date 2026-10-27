import type { SystemRole, TypeRules } from "./reply-type";

// Starter reply types for an organization's first reply type set.
// The four groups are fixed by the schema; reply types and their rules are editable per organization afterwards.
// Migration 0003 gives existing organizations the same rules, roles and names.

export const DEFAULT_PIPELINE_NAME = "Default";

export interface DefaultReplyType {
  groupKey: "customer" | "interested" | "not_interested" | "other";
  key: string;
  name: string;
  rules: TypeRules;
  systemRole?: SystemRole;
  /** What the reply type means. Shown to the classifier next to the name. */
  description: string;
  /** When to pick it and when not to. Shown to the classifier. Editable per organization. */
  classificationGuidance: string;
}

export const DEFAULT_REPLY_TYPES: readonly DefaultReplyType[] = [
  {
    groupKey: "interested",
    key: "information_requested",
    name: "Information requested",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person asks for product, pricing, feature, integration, or company details before deciding.",
    classificationGuidance: "Pick this when the main ask is for answers or material and the person names no case study, meeting, demo, or trial. A question about price or how something works belongs here. If the reply also asks for a call, prefer Meeting requested.",
  },
  {
    groupKey: "interested",
    key: "case_study",
    name: "Case study",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person asks for a customer story, reference, or proof of results.",
    classificationGuidance: "Pick this when the person asks for a case study, a customer example, numbers from a similar company, or a reference call with a customer. A general request for more information belongs under Information requested.",
  },
  {
    groupKey: "interested",
    key: "demo_request",
    name: "Demo request",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person wants to see the product in action.",
    classificationGuidance: "Pick this when the person asks for a demo, a walkthrough, a product tour, or a recording of the product. If they only ask to talk, pick Meeting requested. If they ask for hands-on access, pick Trial requested.",
  },
  {
    groupKey: "interested",
    key: "meeting_requested",
    name: "Meeting requested",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person agrees to talk or asks to book a time.",
    classificationGuidance: "Pick this when the person proposes times, asks for your availability or a calendar link, or says yes to a call you suggested. A reply that only says they are interested, with no mention of a call, belongs under Information requested.",
  },
  {
    groupKey: "interested",
    key: "meeting_no_show",
    name: "Missed meeting",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "A booked meeting passed and the person did not attend.",
    classificationGuidance: "Pick this when the person writes that they missed the meeting or asks to rebook after a missed slot, or when the thread shows a confirmed time that has passed with no attendance. Do not pick it for a person who cancels in advance; that is a new Meeting requested.",
  },
  {
    groupKey: "interested",
    key: "meeting_done",
    name: "After a meeting",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The meeting took place and a follow-up is due.",
    classificationGuidance: "Pick this when the thread shows that the call happened and the next message should recap what was discussed, who owns which action, and what comes next. Thanks for your time after a call is a typical signal.",
  },
  {
    groupKey: "interested",
    key: "trial_requested",
    name: "Trial requested",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person wants to start a trial or asks how to get access.",
    classificationGuidance: "Pick this when the person asks to start, activate, or get access to a trial or a sandbox, or asks what the next step to begin is. Once they are already using the trial, pick Trial question.",
  },
  {
    groupKey: "interested",
    key: "trial_user",
    name: "Trial question",
    rules: { checkMode: "after", replyDraft: true, followUps: "continue" },
    description: "The person already uses the trial and needs help or reports progress.",
    classificationGuidance: "Pick this when a person with an active trial writes about setup, an integration, a feature they tried, an error, or onboarding. A first request for access belongs under Trial requested.",
  },
  {
    groupKey: "customer",
    key: "customer",
    name: "Customer question",
    rules: { checkMode: "before", replyDraft: true, followUps: "stop" },
    systemRole: "customer",
    description: "The person is an existing customer, for example a billing, renewal, or account question.",
    classificationGuidance: "Pick this when the sender is already a paying customer and writes about their account, an invoice, a renewal, or support for the product they use. A cold prospect who sounds enthusiastic is not a customer.",
  },
  {
    groupKey: "not_interested",
    key: "do_not_contact",
    name: "Asked to stop",
    rules: { checkMode: "before", replyDraft: false, followUps: "stop" },
    systemRole: "stop_request",
    description: "The person asks to stop all contact or be removed from outreach.",
    classificationGuidance: "Pick this only for an explicit request to unsubscribe, stop emailing, remove the address, or never be contacted again. Irritation, a polite no, or a request to come back later do not qualify.",
  },
  {
    groupKey: "not_interested",
    key: "not_required_right_now",
    name: "Not now",
    rules: { checkMode: "skip", replyDraft: false, followUps: "stop" },
    description: "The person declines for now and may be open to a later conversation.",
    classificationGuidance: "Pick this when the person says the offer is not needed at this time, the timing is wrong, budget or priorities are elsewhere, or asks you to reach out later. Keep the door open: the person has not rejected future contact.",
  },
  {
    groupKey: "not_interested",
    key: "already_using_a_tool",
    name: "Already has a tool",
    rules: { checkMode: "skip", replyDraft: false, followUps: "stop" },
    description: "The person already has a tool, vendor, or process that covers the need.",
    classificationGuidance: "Pick this when the person says a current vendor, product, agency, or in-house process already does the job and they see no reason to switch. A refusal without naming an existing solution belongs under Not now.",
  },
  {
    groupKey: "other",
    key: "wrong_contact",
    name: "Wrong person",
    rules: { checkMode: "before", replyDraft: true, followUps: "stop" },
    description: "The person says they are not the right contact and names nobody else.",
    classificationGuidance: "Pick this when the reply says the message reached the wrong person, or that someone else handles this, but gives no name, address, or introduction. If the reply names or copies a colleague, pick Referred someone else.",
  },
  {
    groupKey: "other",
    key: "connected_to_different_contact",
    name: "Referred someone else",
    rules: { checkMode: "before", replyDraft: true, followUps: "stop" },
    description: "The person points to or introduces the right contact.",
    classificationGuidance: "Pick this when the reply gives another person's name or email address, copies a colleague into the thread, or introduces the person who handles this topic. The new contact is the person to continue with.",
  },
  {
    groupKey: "other",
    key: "left_company",
    name: "Left company",
    rules: { checkMode: "before", replyDraft: false, followUps: "stop" },
    description: "The person no longer works at the company.",
    classificationGuidance: "Pick this when an automatic reply, a colleague, or the person says they left the company or their address is closed. A temporary absence belongs under Out of office, even when the message mentions a long leave.",
  },
  {
    groupKey: "other",
    key: "out_of_office",
    name: "Out of office",
    rules: { checkMode: "before", replyDraft: false, followUps: "stop" },
    description: "The person is away for a limited time and reads email later.",
    classificationGuidance: "Pick this for vacation, leave, travel, or other temporary absence notices, often automatic and with a return date. If the notice says the person has left the company, pick Left company. No reply is needed.",
  },
  {
    groupKey: "other",
    key: "other",
    name: "Unclear",
    rules: { checkMode: "before", replyDraft: true, followUps: "continue" },
    description: "The reply fits none of the other reply types.",
    classificationGuidance: "Pick this only when no other reply type fits the latest message. Prefer a specific reply type whenever the intent is reasonably clear. Newsletters, bounces without a clear cause, and unrelated replies end up here.",
  },
];
