import type { BlockReason } from "../domain/person-delete-policy";

/*
 * The words of the lead delete rules, which the lead page and its confirmation show and the delete answers. The module
 * loads nothing, so a client component may import it.
 */

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  has_sends: "Messages were already sent to this lead. Mark it do not contact instead of deleting it.",
  has_hidden_sends: "This lead got messages in another member's personal campaign. Mark it do not contact instead of deleting it.",
  in_active_campaign: "The lead is still in a running or paused campaign. Cancel its enrollment or finish the campaign first.",
  personal_campaign_sends: "The lead is in another member's personal campaign. Ask its creator, an owner or an admin to delete it, or mark it do not contact.",
  linked_records: "The lead has history, such as replies or conversations. Mark it do not contact instead of deleting it.",
  try_again: "Another change to this lead was in progress. Try the delete again in a moment.",
};

export interface DeleteQualification {
  canDelete: boolean;
  /** One sentence for the section and the first line of the confirmation. */
  summary: string;
  /** What is removed when it qualifies, or the reason and the way out when it does not. */
  detail: string;
}

export function deleteQualification(reason: keyof typeof BLOCK_MESSAGES | null): DeleteQualification {
  if (reason)
    return {
      canDelete: false,
      summary: "This lead cannot be deleted.",
      detail: BLOCK_MESSAGES[reason],
    };
  return {
    canDelete: true,
    summary: "This lead can be deleted.",
    detail: "No message was sent to it, it is in no running or paused campaign and it has no history such as replies, conversations or deals.",
  };
}

/** What a delete removes. Shown next to the button and again in the confirmation. */
export const DELETE_EFFECT = "Deleting removes the lead, its custom fields and its campaign enrollments, and cannot be undone.";

/** What the delete rules protect, in the words of the rules. */
export const DELETE_PROTECTED = "Leads that were already messaged, sit in a running or paused campaign or have history are protected. Mark those do not contact instead.";

/** The confirmation text: what goes, what stays protected, and that this lead qualifies. */
export function deleteConfirmation(qualification: DeleteQualification): string {
  return `${qualification.summary} ${qualification.detail} ${DELETE_EFFECT} ${DELETE_PROTECTED}`;
}
