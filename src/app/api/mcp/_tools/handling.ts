import { z } from "zod";
import { assignRecord, claimRecord } from "@/contexts/conversations/actions/application/assignment";
import { assignmentDeps } from "@/contexts/conversations/actions/infrastructure/assignment-composition";
import { acknowledgeReplyTypePick, addRecordNote, changeReplyType, closeRecord, reopenRecord, undoReplyTypePick } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { ValidationError } from "@/shared/errors";
import { CHANGES, defineTool, need } from "./define";

const REPLY_TYPE_ACTIONS = ["change", "confirm_pick", "undo_pick"] as const;

export const setReplyTypeTool = defineTool({
  name: "set_reply_type",
  title: "Set reply type",
  description: [
    "Sets how a reply handling is classified, as a person does in the inbox. `change` sets the group and reply type (`recordId`, `groupKey`, `replyTypeId` or null for the group alone, `expectedContextVersion` from get_conversation, optional `note`);",
    "a customer type stays locked unless `confirmUnlock`. `confirm_pick` marks an applied AI pick as seen and `undo_pick` reverts it (`replyTypePickId`).",
    "A change can retire open drafts and start or end follow-ups; the answer says which. None of these answers a stop request: send_reply stays refused until a person reviews it.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(REPLY_TYPE_ACTIONS),
    recordId: z.string().optional(),
    groupKey: z.string().optional(),
    replyTypeId: z.string().nullable().optional(),
    expectedContextVersion: z.number().int().optional(),
    confirmUnlock: z.boolean().optional(),
    note: z.string().optional(),
    replyTypePickId: z.string().optional(),
  }),
  output: z.object({
    action: z.enum(REPLY_TYPE_ACTIONS),
    recordId: z.string().nullable(),
    contextVersion: z.number().nullable(),
    draftsRetired: z.number(),
    followUpsStarted: z.boolean(),
    followUpsEnded: z.boolean(),
  }),
  async run({ actor }, input) {
    if (input.action === "change") {
      const recordId = need(input.recordId, "recordId", "change");
      const result = await changeReplyType(replyHandlingDeps(), actor, recordId, {
        groupKey: need(input.groupKey, "groupKey", "change"),
        replyTypeId: input.replyTypeId ?? null,
        expectedContextVersion: need(input.expectedContextVersion, "expectedContextVersion", "change"),
        confirmUnlock: input.confirmUnlock,
        note: input.note,
      });
      const parts = [`Set to ${result.replyTypeKey ?? result.groupKey}, version ${result.contextVersion}.`];
      if (result.draftsRetired > 0) parts.push(`${result.draftsRetired} open draft(s) retired.`);
      if (result.runEnded) parts.push("Follow-ups of the old type ended.");
      if (result.runStarted) parts.push("Follow-ups started.");
      return {
        summary: parts.join(" "),
        structured: { action: input.action, recordId: result.recordId, contextVersion: result.contextVersion, draftsRetired: result.draftsRetired, followUpsStarted: result.runStarted, followUpsEnded: result.runEnded },
      };
    }
    const pickId = need(input.replyTypePickId, "replyTypePickId", input.action);
    if (input.action === "confirm_pick") {
      await acknowledgeReplyTypePick(replyHandlingDeps(), actor, pickId);
      return { summary: "Marked the AI pick as seen.", structured: { action: input.action, recordId: null, contextVersion: null, draftsRetired: 0, followUpsStarted: false, followUpsEnded: false } };
    }
    const undone = await undoReplyTypePick(replyHandlingDeps(), actor, pickId);
    const parts = ["Undid the AI pick."];
    if (undone.draftsRetired > 0) parts.push(`${undone.draftsRetired} open draft(s) retired.`);
    if (undone.runEnded) parts.push("Follow-ups ended.");
    return {
      summary: parts.join(" "),
      structured: { action: input.action, recordId: undone.recordId, contextVersion: null, draftsRetired: undone.draftsRetired, followUpsStarted: false, followUpsEnded: undone.runEnded },
    };
  },
});

const CONVERSATION_ACTIONS = ["add_note", "assign", "claim", "close", "reopen"] as const;

export const updateConversationTool = defineTool({
  name: "update_conversation",
  title: "Update conversation",
  description: [
    "Changes a reply handling (`recordId`) as a person does in the inbox. `add_note` adds a note (`text`); `claim` takes it unassigned;",
    "`assign` gives it to a member or to nobody (`assignedTo`, a user id or null, and `expectedAssignedTo`, who holds it now per get_conversation);",
    "`close` marks it done with a `reason` and retires its open drafts and follow-ups; `reopen` opens it again.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(CONVERSATION_ACTIONS),
    recordId: z.string(),
    text: z.string().optional(),
    assignedTo: z.string().nullable().optional(),
    expectedAssignedTo: z.string().nullable().optional(),
    reason: z.string().optional(),
  }),
  output: z.object({ action: z.enum(CONVERSATION_ACTIONS), recordId: z.string(), assignedTo: z.string().nullable(), changed: z.boolean(), noteId: z.string().nullable() }),
  async run({ actor }, input) {
    const { recordId } = input;
    const answer = (summary: string, extra: { assignedTo?: string | null; changed?: boolean; noteId?: string | null } = {}) => ({
      summary,
      structured: { action: input.action, recordId, assignedTo: extra.assignedTo ?? null, changed: extra.changed ?? true, noteId: extra.noteId ?? null },
    });
    switch (input.action) {
      case "add_note": {
        const note = await addRecordNote(replyHandlingDeps(), actor, recordId, { body: need(input.text, "text", "add_note") });
        return answer("Added the note.", { noteId: note.id });
      }
      case "claim": {
        const result = await claimRecord(assignmentDeps(), actor, recordId);
        return answer(result.changed ? "You hold this conversation now." : "You already hold this conversation.", { assignedTo: result.assignedTo, changed: result.changed });
      }
      case "assign": {
        if (input.assignedTo === undefined) throw new ValidationError("assign needs assignedTo, a user id or null.");
        if (input.expectedAssignedTo === undefined) throw new ValidationError("assign needs expectedAssignedTo, the holder get_conversation showed, or null.");
        const result = await assignRecord(assignmentDeps(), actor, recordId, { assignedTo: input.assignedTo, expectedAssignedTo: input.expectedAssignedTo });
        return answer(result.changed ? "Assignment changed." : "Nothing changed: it already had that assignee.", { assignedTo: result.assignedTo, changed: result.changed });
      }
      case "close":
        await closeRecord(replyHandlingDeps(), actor, recordId, { reason: need(input.reason, "reason", "close") });
        return answer("Closed. Its open drafts and follow-ups are retired.");
      case "reopen":
        await reopenRecord(replyHandlingDeps(), actor, recordId);
        return answer("Reopened.");
    }
  },
});
