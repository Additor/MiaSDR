import { z } from "zod";
import { listTasks } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { getRecordSequence } from "@/contexts/conversations/after-reply/application/sequences";
import { sequenceDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { linkedinReplyDeps, replyDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { getThread } from "@/contexts/conversations/application/inbox";
import { getLinkedInReplyPanel } from "@/contexts/conversations/application/linkedin-reply";
import type { ThreadMessage } from "@/contexts/conversations/application/ports";
import { getRecordDetail } from "@/contexts/conversations/application/reply-handling";
import { getReplyPanel } from "@/contexts/conversations/application/reply-management";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { NotFoundError, ValidationError } from "@/shared/errors";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, clip, counted, EXCERPT_CHARS, excerpt, fencedField, fitItems, iso, LONG_TEXT_CHARS, messageSource, UNTRUSTED_NOTE, untrusted, type ToolOutputContext } from "./output";

/** Characters of one message body a `detailed` answer keeps. */
const DETAILED_BODY_CHARS = 4000;
/** Characters of one note an answer keeps. */
const NOTE_CHARS = 500;
/** The latest notes and AI picks an answer lists. */
const RECENT = 5;

const message = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  at: z.string(),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  text: z.string(),
  /** The body was longer than the answer keeps; `text` ends with "…". */
  truncated: z.boolean(),
});

const output = z.object({
  conversationId: z.string(),
  recordId: z.string(),
  channel: z.string(),
  account: z.string(),
  appUrl: z.string(),
  person: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), title: z.string().nullable(), company: z.string().nullable() }),
  record: z.object({
    workflowState: z.string(),
    contextVersion: z.number(),
    assignedTo: z.string().nullable(),
    replyTypeId: z.string().nullable(),
    replyTypeName: z.string().nullable(),
    group: z.string().nullable(),
    nextActionAt: z.string().nullable(),
    closedReason: z.string().nullable(),
    doNotContact: z.boolean(),
    suppressed: z.boolean(),
  }),
  messages: z.array(message),
  messagesOmitted: z.number(),
  draft: z
    .object({
      draftId: z.string(),
      status: z.string(),
      revision: z.number(),
      source: z.string(),
      subject: z.string().nullable(),
      text: z.string(),
      /** The draft was longer than the answer keeps; `text` ends with "…". */
      truncated: z.boolean(),
      error: z.string().nullable(),
    })
    .nullable(),
  aiPicks: z.array(z.object({ replyTypePickId: z.string(), status: z.string(), proposed: z.string().nullable(), applied: z.string().nullable(), confidence: z.number().nullable() })),
  notes: z.array(z.object({ title: z.string().nullable(), text: z.string(), author: z.string().nullable(), at: z.string() })),
  tasks: z.array(z.object({ taskId: z.string(), name: z.string(), dueAt: z.string().nullable(), assigneeName: z.string().nullable() })),
  followUps: z.object({ status: z.string(), steps: z.array(z.object({ name: z.string(), status: z.string(), dueAt: z.string() })) }).nullable(),
});

/** A message as the answer carries it: ours as written, the lead's fenced; `concise` keeps an excerpt of each. */
function toMessage(ctx: ToolOutputContext, channel: string, m: ThreadMessage, detailed: boolean): z.infer<typeof message> {
  // `excerpt` folds whitespace before it measures, so a concise body is cut only when its one-line form is too long.
  const { text: body, truncated } = detailed ? clip(m.bodyText, DETAILED_BODY_CHARS) : { text: excerpt(m.bodyText), truncated: m.bodyText.replace(/\s+/g, " ").trim().length > EXCERPT_CHARS };
  const source = messageSource(channel);
  const inbound = m.direction === "inbound";
  return {
    id: m.id,
    direction: m.direction,
    at: m.at.toISOString(),
    // The From header of an inbound message is whatever the sender wrote.
    from: inbound && m.from !== null ? untrusted(ctx, source, m.from) : m.from,
    subject: inbound && m.subject !== null ? untrusted(ctx, source, m.subject) : m.subject,
    text: inbound ? untrusted(ctx, source, body) : body,
    truncated,
  };
}

export const getConversationTool = defineTool({
  name: "get_conversation",
  title: "Get conversation",
  description: [
    "One conversation with its lead, reply handling state, messages, the open draft, AI reply-type picks, notes, open tasks and follow-ups. Pass `conversationId`, or `recordId` for the main conversation of that reply handling.",
    "`response_format` `concise` (default) gives a 200-character excerpt of each message; `detailed` gives each body up to 4,000 characters and marks a longer one `truncated`. Long threads keep the newest messages.",
    "The draft text keeps 12,000 characters and marks a longer one `truncated`; `edit` replaces the whole text, so rewrite a truncated draft in full or leave it to the person.",
    "Write tools take `contextVersion`, the draft's `revision` and `assignedTo` from this answer.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    conversationId: z.string().optional(),
    recordId: z.string().optional(),
    response_format: z.enum(["concise", "detailed"]).optional(),
  }),
  output,
  async run({ actor, out }, input) {
    if (input.conversationId && input.recordId) throw new ValidationError("Pass conversationId or recordId, not both.");
    if (!input.conversationId && !input.recordId) throw new ValidationError("Pass conversationId or recordId.");
    const handling = replyHandlingDeps();
    let conversationId = input.conversationId;
    let byRecord: Awaited<ReturnType<typeof getRecordDetail>> | null = null;
    if (!conversationId) {
      byRecord = await getRecordDetail(handling, actor, input.recordId!);
      const record = byRecord;
      const main = record.conversations.find((c) => c.channel === record.record.activeChannel) ?? record.conversations[0];
      if (!main) throw new NotFoundError("Conversation not found");
      conversationId = main.id;
    }
    const thread = await getThread(inboxDeps(), actor, conversationId);
    const [detail, panel, sequence, tasks] = await Promise.all([
      byRecord ?? getRecordDetail(handling, actor, thread.recordId),
      thread.channel === "linkedin" ? getLinkedInReplyPanel(linkedinReplyDeps(), actor, conversationId) : getReplyPanel(replyDeps(), actor, conversationId),
      getRecordSequence(sequenceDeps(), actor, thread.recordId),
      listTasks(taskDeps(), actor, { recordId: thread.recordId, state: "open" }),
    ]);

    const detailed = input.response_format === "detailed";
    const newestFirst = [...thread.messages].reverse().map((m) => toMessage(out, thread.channel, m, detailed));
    const fitted = fitItems(newestFirst);
    const draft = panel?.draft
      ? "aiBodyText" in panel.draft
        ? { draftId: panel.draft.id, status: panel.draft.status, revision: panel.draft.revision, source: panel.draft.source, subject: panel.draft.subject, ...clip(panel.draft.editedBodyText ?? panel.draft.aiBodyText ?? "", LONG_TEXT_CHARS), error: panel.draft.error }
        : { draftId: panel.draft.id, status: panel.draft.status, revision: panel.draft.revision, source: panel.draft.source, subject: null, ...clip(panel.draft.text, LONG_TEXT_CHARS), error: panel.draft.error }
      : null;
    const { record, person } = detail;

    const structured = {
      conversationId,
      recordId: thread.recordId,
      channel: thread.channel,
      account: thread.accountLabel,
      appUrl: appLinks(out).conversation(conversationId),
      person: { id: person.id, name: person.name, email: person.email, title: fencedField(out, person.title), company: fencedField(out, person.company) },
      record: {
        workflowState: record.workflowState,
        contextVersion: record.contextVersion,
        assignedTo: record.assignedTo,
        replyTypeId: record.replyTypeId,
        replyTypeName: record.replyTypeName,
        group: record.groupKey,
        nextActionAt: iso(record.nextActionAt),
        closedReason: record.closedReason,
        doNotContact: detail.policy?.doNotContact ?? false,
        suppressed: detail.suppressed,
      },
      messages: fitted.items.reverse(),
      messagesOmitted: fitted.omitted,
      draft,
      aiPicks: detail.replyTypePicks.slice(0, RECENT).map((p) => ({ replyTypePickId: p.id, status: p.status, proposed: p.proposed.name, applied: p.applied.name, confidence: p.confidence })),
      notes: detail.notes.slice(0, RECENT).map((n) => ({ title: n.title, text: excerpt(n.body, NOTE_CHARS), author: n.authorName, at: n.createdAt.toISOString() })),
      tasks: tasks.map((t) => ({ taskId: t.id, name: t.name, dueAt: iso(t.dueAt), assigneeName: t.assigneeName })),
      followUps: sequence.run ? { status: sequence.run.statusLabel, steps: sequence.run.steps.map((s) => ({ name: s.name, status: s.status, dueAt: s.dueAt.toISOString() })) } : null,
    };
    const summary = [
      `${person.name ?? person.email ?? "Unknown person"} on ${thread.channel}, ${counted(thread.messages.length, "message")}${fitted.omitted > 0 ? ` (the oldest ${fitted.omitted} left out)` : ""}. State ${record.workflowState}${record.replyTypeName ? `, reply type ${record.replyTypeName}` : ""}.`,
      draft ? `Open draft ${draft.draftId}, ${draft.status}, revision ${draft.revision}${draft.truncated ? ", text cut at 12,000 characters" : ""}.` : "No open draft.",
      UNTRUSTED_NOTE,
    ].join("\n");
    return { summary, structured };
  },
});
