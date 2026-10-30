import { z } from "zod";
import { INBOX_PAGE_SIZE, listInbox, listScheduledInbox } from "@/contexts/conversations/application/inbox";
import { DATE_MODES, INBOX_GROUPS, INBOX_VIEWS, parseInboxParams } from "@/contexts/conversations/domain/inbox-filter";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, fencedExcerpt, messageSource, UNTRUSTED_NOTE, untrusted } from "./output";

const conversation = z.object({
  conversationId: z.string(),
  recordId: z.string(),
  personId: z.string(),
  personName: z.string().nullable(),
  personEmail: z.string().nullable(),
  channel: z.string(),
  assignedTo: z.string().nullable(),
  subject: z.string().nullable(),
  lastMessage: z.string(),
  lastMessageAt: z.string(),
  lastDirection: z.enum(["inbound", "outbound"]),
  unreadCount: z.number(),
  replyTypeName: z.string().nullable(),
  appUrl: z.string(),
});

const scheduled = z.object({
  kind: z.enum(["campaign", "follow_up"]),
  personId: z.string(),
  personName: z.string().nullable(),
  channel: z.string(),
  sourceName: z.string(),
  stepLabel: z.string(),
  subject: z.string().nullable(),
  dueAt: z.string(),
});

const output = z.object({
  view: z.enum(INBOX_VIEWS),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  conversations: z.array(conversation),
  scheduled: z.array(scheduled),
});

export const listInboxTool = defineTool({
  name: "list_inbox",
  title: "List inbox",
  description: [
    "Conversations, newest first, 25 a page. `view`: `all` (default, leaves out machine mail), `unread`, `important`, `sent`, `replied`, `ooo`, `automated`, or `scheduled` (campaign steps and follow-ups due to send, in `scheduled`).",
    "`query` searches names, emails, subjects and every message body. Each conversation gives the `conversationId` for get_conversation and the `recordId` that notes, assignment and closing take.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    view: z.enum(INBOX_VIEWS).optional(),
    query: z.string().optional(),
    page: z.number().int().optional(),
    personIds: z.array(z.string()).optional(),
    campaignIds: z.array(z.string()).optional(),
    mailboxIds: z.array(z.string()).optional(),
    replyTypeKeys: z.array(z.string()).optional(),
    groups: z.array(z.enum(INBOX_GROUPS)).optional(),
    dateMode: z.enum(DATE_MODES).optional(),
    dateFrom: z.string().optional().describe("YYYY-MM-DD in the organization's time zone, with dateMode custom."),
    dateTo: z.string().optional(),
  }),
  output,
  async run({ actor, out }, input) {
    // The page's own URL reader applies the caps and drops malformed ids, so the tool and the page filter alike.
    const params = parseInboxParams({
      view: input.view,
      q: input.query,
      page: input.page === undefined ? undefined : String(input.page),
      lead: input.personIds,
      campaign: input.campaignIds,
      mailbox: input.mailboxIds,
      subcategory: input.replyTypeKeys,
      category: input.groups,
      range: input.dateMode,
      from: input.dateFrom,
      to: input.dateTo,
    });
    const deps = inboxDeps();
    const links = appLinks(out);
    const base = { view: params.view, page: params.page, pageSize: INBOX_PAGE_SIZE };

    if (params.view === "scheduled") {
      const { rows, total } = await listScheduledInbox(deps, actor, params);
      const structured = {
        ...base,
        total,
        conversations: [],
        // `sequence` is the code name of a follow-up after a reply.
        scheduled: rows.map((r) => ({ kind: r.kind === "sequence" ? ("follow_up" as const) : r.kind, personId: r.personId, personName: r.personName, channel: r.channel, sourceName: r.sourceName, stepLabel: r.stepLabel, subject: r.subject, dueAt: r.dueAt.toISOString() })),
      };
      return { summary: `${total} scheduled sends. Page ${params.page}.`, structured };
    }

    const { rows, total } = await listInbox(deps, actor, params);
    const conversations = rows.map((r) => ({
      conversationId: r.conversationId,
      recordId: r.recordId,
      personId: r.personId,
      personName: r.personName,
      personEmail: r.personEmail,
      channel: r.channel,
      assignedTo: r.assignedTo,
      // Our own last message is not fenced; the lead's subject and text are.
      subject: r.lastDirection === "inbound" && r.subject !== null ? untrusted(out, messageSource(r.channel), r.subject) : r.subject,
      lastMessage: r.lastDirection === "inbound" ? (fencedExcerpt(out, r.channel, r.snippet) ?? "") : r.snippet,
      lastMessageAt: r.lastMessageAt.toISOString(),
      lastDirection: r.lastDirection,
      unreadCount: r.unreadCount,
      replyTypeName: r.replyTypeName,
      appUrl: links.conversation(r.conversationId),
    }));
    const pages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
    const summary = [`${total} conversations in ${params.view}. Page ${params.page} of ${pages}.`, ...(conversations.some((c) => c.lastDirection === "inbound") ? [UNTRUSTED_NOTE] : [])].join("\n");
    return { summary, structured: { ...base, total, conversations, scheduled: [] } };
  },
});
