import { z } from "zod";
import { getThread } from "@/contexts/conversations/application/inbox";
import { sendLinkedInReply } from "@/contexts/conversations/application/linkedin-reply";
import { approveAndSendDraft } from "@/contexts/conversations/application/reply-management";
import { replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { linkedinReplySendDeps, replySendDeps } from "@/contexts/conversations/infrastructure/reply-send-composition";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { defineTool } from "./define";
import { appLinks, LONG_TEXT_CHARS } from "./output";

const STATUSES = ["sent", "delivery_uncertain", "failed", "blocked", "in_progress"] as const;

/** Blocks that leave the draft in review, so a later call with a new key may send it. The rest end the draft. */
const RETRYABLE_BLOCKS = new Set(["mailbox_unavailable", "cc_blocked", "not_connected", "paused"]);

const NEXT_STEP: Record<(typeof STATUSES)[number], string> = {
  sent: "The reply went out.",
  delivery_uncertain: "The outcome is unknown: it may have gone out. Do not send it again. A person checks and marks it in MiaSDR.",
  failed: "Nothing went out. The draft is back in review; fix the cause and send with a new idempotencyKey.",
  blocked: "Nothing went out.",
  in_progress: "This key's send is still running. Ask again with the same key in a moment.",
};

/**
 * The sentence the agent reads. An uncertain outcome stores whatever the provider call threw, which can be a database
 * error or a provider's body, so the agent reads the plain step instead; the person sees the stored text in MiaSDR.
 */
const agentError = (result: { status: string; error: string | null }): string | null => (result.status === "delivery_uncertain" ? null : result.error);

/**
 * The one tool that sends. It runs the same function as the Send button, with the agent rules on top (docs/decisions.md,
 * "Agent sends"). This module and the two Send routes are the only importers of the send deps
 * (`reply-send-imports.test.ts`).
 */
export const sendReplyTool = defineTool({
  name: "send_reply",
  title: "Send reply",
  description: [
    "Sends a conversation's reviewed draft as it is saved, by email or LinkedIn, as the token's person. Pass `conversationId`, `draftId`, `revision` from the last read, and an `idempotencyKey` (8 to 200 characters) you keep for this one send; the same key never sends twice.",
    "Agents reply only where a campaign reached the person or a person already replied, without CC, at most once a day per reply handling and within the organization's daily limits; a refusal names its `code`.",
    "A draft longer than the 12,000 characters an answer shows is refused (`draft_not_read`): shorten it with write_reply_draft, or a person sends it.",
    "Send only when the person asked for it or their standing instructions cover it.",
  ].join(" "),
  scope: "mcp:send",
  sends: "replies",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ conversationId: z.string(), draftId: z.string(), revision: z.number().int(), idempotencyKey: z.string() }),
  output: z.object({
    conversationId: z.string(),
    status: z.enum(STATUSES),
    attemptId: z.string(),
    replayed: z.boolean(),
    retryable: z.boolean(),
    error: z.string().nullable(),
    appUrl: z.string(),
  }),
  buckets: () => ["write", "send"],
  async run({ actor, out }, input) {
    const { channel } = await getThread(inboxDeps(), actor, input.conversationId);
    // The draft must belong to the conversation the agent named; another organization's draft answers not found.
    const draft = await replyDeps().store.getDraft(actor.organizationId, input.draftId);
    if (!draft || draft.conversationId !== input.conversationId) throw new NotFoundError("Draft not found");
    // An agent sends only text it could read whole. A draft already sending or sent falls through to the replay answer.
    if (draft.status === "awaiting_review" && (draft.editedBodyText ?? draft.aiBodyText ?? "").length > LONG_TEXT_CHARS) {
      throw new ConflictError(`The draft is longer than the ${LONG_TEXT_CHARS} characters an answer shows, so the agent has not read all of it. Shorten it with write_reply_draft, or a person sends it in MiaSDR.`, { code: "draft_not_read" });
    }
    const result =
      channel === "linkedin"
        ? await sendLinkedInReply(linkedinReplySendDeps(), actor, input.conversationId, { draftId: draft.id, revision: input.revision, idempotencyKey: input.idempotencyKey })
        : await approveAndSendDraft(replySendDeps(), actor, draft.id, { revision: input.revision, idempotencyKey: input.idempotencyKey });
    const error = "error" in result ? agentError(result) : null;
    // A replay answers what this key did before, so a block it reports says nothing about sending now.
    const retryable = result.status === "failed" || (result.status === "blocked" && !result.replayed && RETRYABLE_BLOCKS.has(result.reason));
    return {
      summary: [error, NEXT_STEP[result.status], result.replayed ? "This key had already sent; nothing new went out." : null].filter(Boolean).join(" "),
      structured: { conversationId: input.conversationId, status: result.status, attemptId: result.attemptId, replayed: result.replayed, retryable, error, appUrl: appLinks(out).conversation(input.conversationId) },
    };
  },
});
