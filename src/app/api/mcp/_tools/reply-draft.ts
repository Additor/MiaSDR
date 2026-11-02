import { z } from "zod";
import { linkedinReplyDeps, replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { getThread } from "@/contexts/conversations/application/inbox";
import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import { createManualDraft, discardDraft, editDraft, getReplyPanel, regenerateDraft, requestDraft } from "@/contexts/conversations/application/reply-management";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { defineTool, need, type ToolContext } from "./define";
import { appLinks, clip, cutCopyRefusal, fencedField, isCutCopy, LONG_TEXT_CHARS, unfenced, type ToolOutputContext } from "./output";

const ACTIONS = ["request_ai", "create_manual", "edit", "regenerate", "discard"] as const;

const draftView = z.object({ draftId: z.string(), status: z.string(), revision: z.number(), subject: z.string().nullable(), text: z.string(), truncated: z.boolean() });

/** The conversation's open draft as `get_conversation` shows it, text cut the same way, or null when it has none. */
async function readDraft(actor: Actor, out: ToolOutputContext, conversationId: string): Promise<z.infer<typeof draftView> | null> {
  const thread = await getThread(inboxDeps(), actor, conversationId);
  if (thread.channel === "linkedin") {
    const d = (await getLinkedInReplyPanel(linkedinReplyDeps(), actor, conversationId))?.draft;
    return d ? { draftId: d.id, status: d.status, revision: d.revision, subject: null, ...clip(d.text, LONG_TEXT_CHARS) } : null;
  }
  const d = (await getReplyPanel(replyDeps(), actor, conversationId))?.draft;
  // A subject can repeat what the lead wrote, so it comes fenced; the writes below take the tags off again.
  return d ? { draftId: d.id, status: d.status, revision: d.revision, subject: fencedField(out, d.subject), ...clip(d.editedBodyText ?? d.aiBodyText ?? "", LONG_TEXT_CHARS) } : null;
}

/** The conversation a draft belongs to and its saved text; another organization's draft answers not found. */
async function draftOf(actor: Actor, draftId: string): Promise<{ conversationId: string; text: string }> {
  const draft = await replyDeps().store.getDraft(actor.organizationId, draftId);
  if (!draft) throw new NotFoundError("Draft not found");
  return { conversationId: draft.conversationId, text: draft.editedBodyText ?? draft.aiBodyText ?? "" };
}

export const writeReplyDraftTool = defineTool({
  name: "write_reply_draft",
  title: "Write reply draft",
  description: [
    "Writes the reply draft of a conversation for a person to review and send in MiaSDR. Nothing is sent.",
    "`request_ai` has the AI write one (`conversationId`); `create_manual` saves your text as the draft (`conversationId`, `bodyText`, and `subject` for email; with an open draft also its `revision`, since it replaces that draft);",
    "`edit` replaces the draft's text (`draftId`, `revision`, `bodyText`, optional `subject`); `regenerate` has the AI write it again (`draftId`, `revision`, optional `note`); `discard` drops it (`draftId`, `revision`).",
    "`edit` and `create_manual` refuse text that looks made from an answer that cut the draft (`truncated_text`). Take `revision` from get_conversation or the last answer. The answer gives the draft and `reviewUrl`, where the person reviews and sends it.",
  ].join(" "),
  scope: "mcp:write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: z.object({
    action: z.enum(ACTIONS),
    conversationId: z.string().optional(),
    draftId: z.string().optional(),
    revision: z.number().int().optional(),
    subject: z.string().optional(),
    bodyText: z.string().optional(),
    note: z.string().optional(),
  }),
  output: z.object({ action: z.enum(ACTIONS), conversationId: z.string(), draft: draftView.nullable(), reviewUrl: z.string() }),
  buckets: (input) => (input.action === "request_ai" || input.action === "regenerate" ? ["write", "ai"] : ["write"]),
  async run({ actor, out }: ToolContext, input) {
    let conversationId: string;
    switch (input.action) {
      case "request_ai":
        conversationId = need(input.conversationId, "conversationId", "request_ai");
        await requestDraft(replyDeps(), actor, conversationId);
        break;
      case "create_manual": {
        conversationId = need(input.conversationId, "conversationId", "create_manual");
        // The thread alone tells the channel; the draft is read once, after the write.
        const { channel } = await getThread(inboxDeps(), actor, conversationId);
        const bodyText = unfenced(need(input.bodyText, "bodyText", "create_manual"));
        // A new draft turns the open one stale, so the agent must have read that one, as `edit` and `discard` require.
        const open = await readDraft(actor, out, conversationId);
        if (open?.status === "awaiting_review") {
          if (input.revision !== open.revision) throw new ConflictError(`This conversation has an open draft at revision ${open.revision}. Read it, then pass that revision to replace it, or use edit.`, { code: "draft_open" });
          if (isCutCopy(bodyText, (await draftOf(actor, open.draftId)).text, LONG_TEXT_CHARS)) throw cutCopyRefusal("draft text");
        }
        await createManualDraft(replyDeps(), actor, conversationId, { subject: input.subject && unfenced(input.subject), bodyText, channel: channel === "linkedin" ? "linkedin" : "email" });
        break;
      }
      case "edit": {
        const draftId = need(input.draftId, "draftId", "edit");
        const bodyText = unfenced(need(input.bodyText, "bodyText", "edit"));
        const saved = await draftOf(actor, draftId);
        if (isCutCopy(bodyText, saved.text, LONG_TEXT_CHARS)) throw cutCopyRefusal("draft text");
        conversationId = saved.conversationId;
        await editDraft(replyDeps(), actor, draftId, { revision: need(input.revision, "revision", "edit"), subject: input.subject && unfenced(input.subject), bodyText });
        break;
      }
      case "regenerate": {
        const draftId = need(input.draftId, "draftId", "regenerate");
        ({ conversationId } = await draftOf(actor, draftId));
        await regenerateDraft(replyDeps(), actor, draftId, { note: input.note, expectedRevision: need(input.revision, "revision", "regenerate") });
        break;
      }
      case "discard": {
        const draftId = need(input.draftId, "draftId", "discard");
        ({ conversationId } = await draftOf(actor, draftId));
        await discardDraft(replyDeps(), actor, draftId, { expectedRevision: need(input.revision, "revision", "discard") });
        break;
      }
    }
    const draft = await readDraft(actor, out, conversationId);
    const reviewUrl = appLinks(out).conversation(conversationId);
    const summary =
      input.action === "discard"
        ? `Discarded the draft. ${draft ? `The conversation's draft is now ${draft.draftId}, ${draft.status}.` : "The conversation has no open draft."}`
        : draft
          ? `Draft ${draft.draftId} is ${draft.status.replaceAll("_", " ")}, revision ${draft.revision}. A person reviews and sends it at ${reviewUrl}.`
          : "The conversation has no open draft.";
    return { summary, structured: { action: input.action, conversationId, draft, reviewUrl } };
  },
});
