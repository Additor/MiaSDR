import { humanizeToken } from "@/shared/humanize";

/**
 * Activity wording for every `events.event_type` the code writes. `{stage}` in a label is the stage name of the event's
 * `to_data`. A type without a label falls back to a readable form of its token, so a new type still prints something.
 */
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  "reply_type.changed": "Changed category",
  "assignee.changed": "Changed who handles the replies",
  "reply_type_pick.applied": "AI set the category",
  "reply_type_pick.proposed": "AI suggested a category",
  "reply_type_pick.failed": "AI classification failed",
  "reply_type_pick.accepted": "Accepted the AI's suggestion",
  "reply_type_pick.overridden": "Changed the category",
  "reply_type_pick.undone": "Undid a classification",
  "reply_type_pick.acknowledged": "Reviewed a classification",
  "contact_policy.dnc_set": "Marked do not contact",
  "contact_policy.dnc_cleared": "Cleared do not contact",
  "contact_policy.enforced": "Applied do not contact",
  "contact.suppressed": "Added the address to the suppression list",
  "draft.created_manual": "Wrote a draft",
  "draft.sent": "Sent a reply",
  "draft.discarded": "Discarded a draft",
  "draft.delivery_reconciled": "Confirmed a reply was delivered",
  "draft.not_delivered": "Marked a reply as not delivered",
  "workflow.state_changed": "Changed the workflow state",
  "sequence.started": "Started follow-ups",
  "sequence.paused": "Paused follow-ups",
  "sequence.resumed": "Resumed follow-ups",
  "sequence.cancelled": "Stopped follow-ups",
  "sequence.completed": "Finished follow-ups",
  "sequence.interrupted": "Follow-ups stopped",
  "sequence.draft_created": "Drafted a follow-up for approval",
  "sequence.step_sent": "Sent a follow-up",
  "sequence.step_skipped": "Skipped a follow-up step",
  "sequence.override_set": "Chose follow-ups for this person",
  "sequence.override_cleared": "Cleared the follow-ups choice for this person",
  "enrollment.restored": "Restored to a campaign",
  "outreach.stopped_by_reply": "Stopped outreach after a reply",
  "lifecycle.converted": "Became a contact",
  "contact.added": "Added as a contact",
  "deal.created": "Created deal",
  "deal.stage_moved": "Moved deal to {stage}",
  "deal.updated": "Updated deal",
  "deal.deleted": "Deleted deal",
};

/** The Activity line of one event. */
export function eventLabel(event: { eventType: string; toData?: unknown }): string {
  if (event.eventType === "assignee.changed") {
    const to = event.toData as { assignedTo?: unknown; assigneeName?: unknown } | null | undefined;
    if (!to?.assignedTo) return "Unassigned the conversation";
    return typeof to.assigneeName === "string" && to.assigneeName.trim() !== "" ? `Assigned to ${to.assigneeName}` : "Assigned the conversation";
  }
  const label = EVENT_LABELS[event.eventType];
  if (!label) return humanizeToken(event.eventType.replace(/\./g, " "));
  if (!label.includes("{stage}")) return label;
  const stage = (event.toData as { stageName?: unknown } | null | undefined)?.stageName;
  return typeof stage === "string" && stage.trim() !== "" ? label.replace("{stage}", stage) : "Moved deal to another stage";
}
