import { z } from "zod";
import { linkedinReplyDeps, replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { getThread } from "@/contexts/conversations/application/inbox";
import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import { createManualDraft, discardDraft, editDraft, getReplyPanel, regenerateDraft, requestDraft } from "@/contexts/conversations/application/reply-management";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { defineTool, type ToolContext } from "./define";
import { appLinks } from "./output";

const ACTIONS = ["request_ai", "create_manual", "edit", "regenerate", "discard"] as const;

const draftView = z.object({ draftId: z.string(), status: z.string(), revision: z.number(), subject: z.string().nullable(), text: z.string() });

/** The conversation's open draft as `get_conversation` shows it, or null when it has none. */
async function readDraft(actor: Actor, conversationId: string): Promise<{ channel: string; draft: z.infer<typeof draftView> | null }> {
  const thread = await getThread(inboxDeps(), actor, conversationId);
  if (thread.channel === "linkedin") {
    const panel = await getLinkedInReplyPanel(linkedinReplyDeps(), actor, conversationId);
    const d = panel?.draft;
    return { channel: thread.channel, draft: d ? { draftId: d.id, status: d.status, revision: d.revision, subject: null, text: d.text } : null };
  }
  const panel = await getReplyPanel(replyDeps(), actor, conversationId);
  const d = panel?.draft;
  return {
    channel: thread.channel,
    draft: d ? { draftId: d.id, status: d.status, revision: d.revision, subject: d.subject, text: d.editedBodyText ?? d.aiBodyText ?? "" } : null,
  };
}

/** The conversation a draft belongs to; another organization's draft answers not found. */
async function conversationOfDraft(actor: Actor, draftId: string): Promise<string> {
  const draft = await replyDeps().store.getDraft(actor.organizationId, draftId);
  if (!draft) throw new NotFoundError("Draft not found");
  return draft.conversationId;
}

const need = <T>(value: T | undefined, what: string, action: string): T => {
  if (value === undefined) throw new ValidationError(`${action} needs ${what}.`);
  return value;
};

export const writeReplyDraftTool = defineTool({
  name: "write_reply_draft",
  title: "Write reply draft",
  description: [
    "Writes the reply draft of a conversation for a person to review and send in MiaSDR. Nothing is sent.",
    "`request_ai` has the AI write one (`conversationId`); `create_manual` saves your text as the draft (`conversationId`, `bodyText`, and `subject` for email; email only for now);",
    "`edit` replaces the draft's text (`draftId`, `revision`, `bodyText`, optional `subject`); `regenerate` has the AI write it again (`draftId`, optional `note`); `discard` drops it (`draftId`, `revision`).",
    "Take `revision` from get_conversation or the last answer. The answer gives the draft and `reviewUrl`, where the person reviews and sends it.",
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
        const { channel } = await readDraft(actor, conversationId);
        if (channel === "linkedin") throw new ValidationError("An agent cannot type a LinkedIn draft yet. Use request_ai, or edit the draft the AI wrote.");
        await createManualDraft(replyDeps(), actor, conversationId, { subject: input.subject, bodyText: need(input.bodyText, "bodyText", "create_manual") });
        break;
      }
      case "edit": {
        const draftId = need(input.draftId, "draftId", "edit");
        conversationId = await conversationOfDraft(actor, draftId);
        await editDraft(replyDeps(), actor, draftId, { revision: need(input.revision, "revision", "edit"), subject: input.subject, bodyText: need(input.bodyText, "bodyText", "edit") });
        break;
      }
      case "regenerate": {
        const draftId = need(input.draftId, "draftId", "regenerate");
        conversationId = await conversationOfDraft(actor, draftId);
        await regenerateDraft(replyDeps(), actor, draftId, { note: input.note });
        break;
      }
      case "discard": {
        const draftId = need(input.draftId, "draftId", "discard");
        conversationId = await conversationOfDraft(actor, draftId);
        await discardDraft(replyDeps(), actor, draftId, { expectedRevision: need(input.revision, "revision", "discard") });
        break;
      }
    }
    const { draft } = await readDraft(actor, conversationId);
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
