import { z } from "zod";
import { INBOX_PAGE_SIZE, listInbox, listScheduledInbox } from "@/contexts/conversations/application/inbox";
import { DATE_MODES, INBOX_GROUPS, INBOX_VIEWS, parseDay, parseInboxParams } from "@/contexts/conversations/domain/inbox-filter";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { ValidationError } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, counted, fencedExcerpt, fencedField, messageSource, UNTRUSTED_NOTE, untrusted } from "./output";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The page's URL reader drops what it cannot read, which would answer the unfiltered inbox as if the filter had applied. */
function refuseUnreadable(input: { campaignIds?: string[]; mailboxIds?: string[]; dateFrom?: string; dateTo?: string }): void {
  const badId = [...(input.campaignIds ?? []), ...(input.mailboxIds ?? [])].find((id): boolean => !isUuid(id));
  if (badId !== undefined) throw new ValidationError(`"${badId.slice(0, 60)}" is not a campaign or mailbox id. Take ids from list_campaigns or get_sending_health.`);
  const badDay = [input.dateFrom, input.dateTo].find((day) => day !== undefined && (!DAY.test(day) || !parseDay(day)));
  if (badDay !== undefined) throw new ValidationError(`"${badDay.slice(0, 60)}" is not a date. Use YYYY-MM-DD.`);
}

const thread = z.object({
  threadId: z.string(),
  conversationId: z.string(),
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
  threads: z.array(thread),
  scheduled: z.array(scheduled),
});

export const listInboxTool = defineTool({
  name: "list_inbox",
  title: "List inbox",
  description: [
    "Conversations, newest first, 25 a page. `view`: `all` (default, leaves out machine mail), `unread`, `important`, `sent`, `replied`, `ooo`, `automated`, or `scheduled` (campaign steps and follow-ups due to send, in `scheduled`).",
    "`query` searches names, emails, subjects and every message body. Each conversation gives the `threadId` for get_conversation and the `conversationId` that notes, assignment and closing take.",
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
    refuseUnreadable(input);
    // The page's own URL reader applies the caps, so the tool and the page filter alike.
    const params = parseInboxParams({
      view: input.view,
      q: input.query,
      page: input.page === undefined ? undefined : String(input.page),
      lead: input.personIds,
      campaign: input.campaignIds,
      mailbox: input.mailboxIds,
      type: input.replyTypeKeys,
      group: input.groups,
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
        threads: [],
        scheduled: rows.map((r) => ({ kind: r.kind, personId: r.personId, personName: r.personName, channel: r.channel, sourceName: r.sourceName, stepLabel: r.stepLabel, subject: fencedField(out, r.subject), dueAt: r.dueAt.toISOString() })),
      };
      return { summary: `${counted(total, "scheduled send")}. Page ${params.page}.`, structured };
    }

    const { rows, total } = await listInbox(deps, actor, params);
    const threads = rows.map((r) => ({
      threadId: r.threadId,
      conversationId: r.conversationId,
      personId: r.personId,
      personName: r.personName,
      personEmail: r.personEmail,
      channel: r.channel,
      assignedTo: r.assignedTo,
      // Fenced whichever way it went: our own message can repeat the lead's subject or carry merged values.
      subject: r.subject === null ? null : untrusted(out, messageSource(r.channel), r.subject),
      lastMessage: fencedExcerpt(out, r.channel, r.snippet) ?? "",
      lastMessageAt: r.lastMessageAt.toISOString(),
      lastDirection: r.lastDirection,
      unreadCount: r.unreadCount,
      replyTypeName: r.replyTypeName,
      appUrl: links.thread(r.threadId),
    }));
    const pages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
    const summary = [`${counted(total, "conversation")} in ${params.view}. Page ${params.page} of ${pages}.`, ...(threads.length > 0 ? [UNTRUSTED_NOTE] : [])].join("\n");
    return { summary, structured: { ...base, total, threads, scheduled: [] } };
  },
});
