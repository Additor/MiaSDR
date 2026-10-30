import { z } from "zod";
import { ANALYTICS_VIEWS, getAnalytics } from "@/contexts/analytics/application/analytics-queries";
import { analyticsDeps } from "@/contexts/analytics/infrastructure/composition";
import { getFailedAiJobs } from "@/contexts/conversations/ai/application/ai-job-ops";
import { aiJobOpsDeps } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { listIdentityExceptions } from "@/contexts/conversations/application/reply-handling";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { getSendPause } from "@/contexts/outreach/application/send-pause";
import { emailRulesDeps, mailboxDeps } from "@/contexts/outreach/infrastructure/composition";
import { listLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { isOutboundPaused } from "@/shared/outbound-pause";
import { defineTool, READ_ONLY } from "./define";
import { iso } from "./output";

export const getAnalyticsTool = defineTool({
  name: "get_analytics",
  title: "Get analytics",
  description: [
    "One analytics report, as the Analytics page shows it: `campaigns`, `channels` (mailboxes and LinkedIn accounts), `linkedin`, `replies` (reply types and suppressions) or `timeseries` (per day).",
    "Days are in the organization's time zone; without `from` and `to` the window is the last 30 days. Filter by `campaignId` or `linkedinAccountId`.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    view: z.enum(ANALYTICS_VIEWS),
    from: z.string().optional().describe("YYYY-MM-DD"),
    to: z.string().optional().describe("YYYY-MM-DD"),
    campaignId: z.string().optional(),
    linkedinAccountId: z.string().optional(),
    excludeArchived: z.boolean().optional(),
  }),
  output: z.object({
    view: z.enum(ANALYTICS_VIEWS),
    from: z.string(),
    to: z.string(),
    timeZone: z.string(),
    // The report shapes are the Analytics page's; the tool passes them through as JSON.
    data: z.record(z.string(), z.unknown()),
  }),
  async run({ actor }, input) {
    const { view, ...request } = input;
    const result = await getAnalytics(analyticsDeps(), actor, view, request);
    const data = JSON.parse(JSON.stringify(result.data)) as Record<string, unknown>;
    const structured = { view, from: result.scope.range.from, to: result.scope.range.to, timeZone: result.scope.timeZone, data };
    return { summary: `The ${view} report from ${structured.from} to ${structured.to} (${structured.timeZone}).`, structured };
  },
});

export const getSendingHealthTool = defineTool({
  name: "get_sending_health",
  title: "Get sending health",
  description:
    "Whether sending is paused, each mailbox's and LinkedIn account's status and use today, inbound mail waiting for a sender decision, and for an owner or admin the failed AI jobs. Check it when sends stall or a reply got no AI draft.",
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({}),
  output: z.object({
    paused: z.object({ organization: z.object({ at: z.string(), byName: z.string().nullable() }).nullable(), install: z.boolean() }),
    mailboxes: z.array(z.object({ id: z.string(), emailAddress: z.string(), status: z.string(), lastError: z.string().nullable(), sentToday: z.number(), dailySendLimit: z.number() })),
    linkedinAccounts: z.array(z.object({ id: z.string(), name: z.string().nullable(), status: z.string(), invitesToday: z.number(), dailyInviteLimit: z.number(), messagesToday: z.number(), dailyMessageLimit: z.number(), limitReachedUntil: z.string().nullable() })),
    unmatchedSenders: z.object({ open: z.number(), latest: z.array(z.object({ channel: z.string(), sender: z.string().nullable(), reason: z.string(), at: z.string() })) }),
    failedAiJobs: z.union([z.object({ total: z.number(), latest: z.array(z.object({ kind: z.string(), lastError: z.string(), failedAt: z.string() })) }), z.literal("omitted")]),
  }),
  async run({ actor }) {
    const admin = isOwnerOrAdmin(actor.role);
    const [pause, mailboxes, linkedin, exceptions, failed] = await Promise.all([
      getSendPause(emailRulesDeps(), actor),
      listMailboxes(mailboxDeps(), actor),
      listLinkedInAccounts(linkedinManagementDeps(), actor),
      listIdentityExceptions(replyHandlingDeps(), actor, "open"),
      admin ? getFailedAiJobs(aiJobOpsDeps(), actor) : null,
    ]);
    const recent = 5;
    const structured = {
      paused: { organization: pause ? { at: pause.at, byName: pause.byName } : null, install: isOutboundPaused() },
      mailboxes: mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, status: m.status, lastError: m.lastError, sentToday: m.sentToday, dailySendLimit: m.dailySendLimit })),
      linkedinAccounts: linkedin.accounts.map((a) => ({ id: a.id, name: a.name, status: a.status, invitesToday: a.invitesToday, dailyInviteLimit: a.dailyInviteLimit, messagesToday: a.messagesToday, dailyMessageLimit: a.dailyMessageLimit, limitReachedUntil: iso(a.limitReachedUntil) })),
      unmatchedSenders: { open: exceptions.length, latest: exceptions.slice(0, recent).map((e) => ({ channel: e.channel, sender: e.identityValue, reason: e.reason, at: e.createdAt.toISOString() })) },
      // A member may not read AI job failures; the field says so instead of looking empty.
      failedAiJobs: failed ? { total: failed.total, latest: failed.rows.slice(0, recent).map((j) => ({ kind: j.kind, lastError: j.lastError, failedAt: j.failedAt.toISOString() })) } : ("omitted" as const),
    };
    const problems = [
      ...(structured.paused.organization || structured.paused.install ? ["Sending is paused."] : []),
      ...structured.mailboxes.filter((m) => m.status !== "connected").map((m) => `Mailbox ${m.emailAddress} is ${m.status}.`),
      ...structured.linkedinAccounts.filter((a) => a.status !== "connected").map((a) => `LinkedIn account ${a.name ?? a.id} is ${a.status}.`),
      ...(exceptions.length > 0 ? [`${exceptions.length} inbound messages wait for a sender decision.`] : []),
      ...(failed && failed.total > 0 ? [`${failed.total} AI jobs failed.`] : []),
    ];
    return { summary: problems.length > 0 ? problems.join("\n") : "Sending looks healthy.", structured };
  },
});
