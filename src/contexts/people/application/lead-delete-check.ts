import type { Actor } from "@/shared/errors";
import { BLOCK_MESSAGES, leadDeleteBlockOf } from "./lead-management";
import type { LeadDeleteDeps } from "./lead-ports";

/*
 * Whether one lead can be deleted, said before the click. The rules are the ones the delete itself applies
 * (`leadDeleteBlock` in the person delete policy, over the same ports), so the page and the server cannot disagree; the
 * server still has the last word.
 */

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

export async function checkLeadDelete(deps: LeadDeleteDeps, actor: Actor, id: string): Promise<DeleteQualification> {
  return deleteQualification(await leadDeleteBlockOf(deps, actor, id));
}
