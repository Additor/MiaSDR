import { z } from "zod";
import { getWorkQueue, getWorkQueueCounts } from "@/contexts/conversations/actions/application/work-queue";
import type { QueueItem } from "@/contexts/conversations/actions/application/work-queue-ports";
import { QUEUE_GROUPS, QUEUE_SCOPES } from "@/contexts/conversations/actions/domain/action-queue";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, counted, DEFAULT_LIST_LIMIT, fencedExcerpt, fencedField, listLimit, OVERVIEW_LIMIT, UNTRUSTED_NOTE, type ToolOutputContext } from "./output";

const item = z.object({
  recordId: z.string(),
  conversationId: z.string().nullable(),
  personId: z.string(),
  personName: z.string().nullable(),
  channel: z.string().nullable(),
  replyTypeName: z.string().nullable(),
  assignee: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  waitingSince: z.string(),
  lastInbound: z.string().nullable(),
  draft: z.object({ draftId: z.string(), status: z.string(), subject: z.string().nullable() }).nullable(),
  aiPick: z.object({ replyTypePickId: z.string(), kind: z.string(), name: z.string().nullable(), confidence: z.number().nullable(), contextVersion: z.number() }).nullable(),
  problem: z.object({ kind: z.string(), message: z.string() }).nullable(),
  appUrl: z.string().nullable(),
});

const output = z.object({
  groups: z.array(z.object({ group: z.enum(QUEUE_GROUPS), total: z.number(), nextCursor: z.string().nullable(), items: z.array(item) })),
  counts: z.object({ total: z.number(), mine: z.number(), unassigned: z.number(), others: z.number() }),
});

function toItem(ctx: ToolOutputContext, i: QueueItem): z.infer<typeof item> {
  const links = appLinks(ctx);
  return {
    recordId: i.recordId,
    conversationId: i.conversationId,
    personId: i.personId,
    personName: i.personName,
    channel: i.channel,
    replyTypeName: i.replyTypeName,
    assignee: i.assignee,
    waitingSince: i.waitingSince.at.toISOString(),
    lastInbound: fencedExcerpt(ctx, i.channel, i.snippet),
    draft: i.draft && { draftId: i.draft.draftId, status: i.draft.status, subject: fencedField(ctx, i.draft.subject) },
    aiPick: i.classification && {
      replyTypePickId: i.classification.replyTypePickId,
      kind: i.classification.kind,
      name: i.classification.name,
      confidence: i.classification.confidence,
      contextVersion: i.classification.contextVersion,
    },
    problem: i.problem,
    appUrl: i.conversationId ? links.conversation(i.conversationId) : links.person(i.personId, i.personLifecycle),
  };
}

export const getWorkQueueTool = defineTool({
  name: "get_work_queue",
  title: "Get work queue",
  description: [
    "What waits on a person, in groups: failed sends and decisions, replies, follow-ups, AI reply-type picks to review, and next steps. The `group` values name them. Oldest first within each group.",
    "Filter with `scope` (`mine`, `unassigned`, `others`), `channel`, `replyTypeId` or `campaignId`. For the next page of one group, pass `group` and that group's `nextCursor`.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    group: z.enum(QUEUE_GROUPS).optional(),
    scope: z.enum(QUEUE_SCOPES).optional(),
    channel: z.enum(["email", "linkedin"]).optional(),
    replyTypeId: z.string().optional(),
    campaignId: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().optional().describe("Items per group: default 5 across every group, 20 with `group`, at most 40."),
  }),
  output,
  async run({ actor, out }, input) {
    const deps = workQueueDeps();
    const { cursor, limit, ...filter } = input;
    const [queue, counts] = await Promise.all([getWorkQueue(deps, actor, { filter, cursor, limit: listLimit(limit, input.group ? DEFAULT_LIST_LIMIT : OVERVIEW_LIMIT) }), getWorkQueueCounts(deps, actor)]);
    const groups = QUEUE_GROUPS.filter((g) => !input.group || g === input.group).map((group) => {
      const page = queue.groups[group];
      return { group, total: page.total, nextCursor: page.nextCursor, items: page.items.map((i) => toItem(out, i)) };
    });
    const structured = { groups, counts: { total: counts.total, ...counts.byScope } };
    const lines = groups.filter((g) => g.total > 0).map((g) => `${g.group}: ${g.total}${g.nextCursor ? ` (showing ${g.items.length})` : ""}`);
    const summary = [
      queue.total === 0 ? "Nothing waits under this filter." : `${counted(queue.total, "item")} ${queue.total === 1 ? "waits" : "wait"}. ${lines.join(", ")}.`,
      `Unfiltered: ${counts.byScope.mine} mine, ${counts.byScope.unassigned} unassigned, ${counts.byScope.others} assigned to others.`,
      ...(groups.some((g) => g.items.some((i) => i.lastInbound || i.draft?.subject)) ? [UNTRUSTED_NOTE] : []),
    ].join("\n");
    return { summary, structured };
  },
});
