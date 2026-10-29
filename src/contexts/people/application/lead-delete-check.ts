import type { Actor } from "@/shared/errors";
import { leadDeleteBlockOf } from "./lead-management";
import { deleteQualification, type DeleteQualification } from "./lead-delete-terms";
import type { LeadDeleteDeps } from "./lead-ports";

export { DELETE_EFFECT, DELETE_PROTECTED, deleteConfirmation, deleteQualification, type DeleteQualification } from "./lead-delete-terms";

/*
 * Whether one lead can be deleted, said before the click. The rules are the ones the delete itself applies
 * (`leadDeleteBlock` in the person delete policy, over the same ports), so the page and the server cannot disagree; the
 * server still has the last word.
 */

export async function checkLeadDelete(deps: LeadDeleteDeps, actor: Actor, id: string): Promise<DeleteQualification> {
  return deleteQualification(await leadDeleteBlockOf(deps, actor, id));
}
