import { z } from "zod";
import { getCampaignDetail, getCampaignSenders, listCampaigns, previewStep } from "@/contexts/outreach/application/campaign-management";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { ENROLLMENT_TABS, parseEnrollmentListQuery } from "@/contexts/outreach/domain/enrollment-list";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { getLinkedInCampaignDetail, getLinkedInCampaignSenders, listLinkedInCampaigns, previewLinkedInStep } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, iso } from "./output";

const CHANNELS = ["email", "linkedin"] as const;

const summaryRow = z.object({
  campaignId: z.string(),
  channel: z.enum(CHANNELS),
  name: z.string(),
  status: z.string(),
  type: z.string(),
  enrolled: z.number(),
  replied: z.number(),
  archived: z.boolean(),
  appUrl: z.string(),
});

export const listCampaignsTool = defineTool({
  name: "list_campaigns",
  title: "List campaigns",
  description: "Email and LinkedIn campaigns with status, enrolled and replied counts. Archived campaigns stay out unless `archived` is `all` or `only`.",
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({ channel: z.enum(CHANNELS).optional(), archived: z.enum(["hide", "all", "only"]).optional() }),
  output: z.object({ campaigns: z.array(summaryRow) }),
  async run({ actor, out }, input) {
    const archived = parseArchiveFilter(input.archived);
    const links = appLinks(out);
    const [email, linkedin] = await Promise.all([
      input.channel === "linkedin" ? [] : listCampaigns(campaignDeps(), actor, archived),
      input.channel === "email" ? [] : listLinkedInCampaigns(linkedinCampaignDeps(), actor, archived),
    ]);
    const campaigns = [
      ...email.map((c) => ({ campaignId: c.id, channel: "email" as const, name: c.name, status: c.status, type: "regular", enrolled: c.enrolled, replied: c.replied, archived: c.archivedAt !== null, appUrl: links.campaign(c.id) })),
      ...linkedin.map((c) => ({ campaignId: c.id, channel: "linkedin" as const, name: c.name, status: c.status, type: c.type, enrolled: c.enrolled, replied: c.replied, archived: c.archivedAt !== null, appUrl: links.campaign(c.id) })),
    ];
    const summary = campaigns.length === 0 ? "No campaigns." : campaigns.map((c) => `${c.name} (${c.channel}, ${c.status}): ${c.enrolled} enrolled, ${c.replied} replied`).join("\n");
    return { summary, structured: { campaigns } };
  },
});

const enrollment = z.object({
  enrollmentId: z.string(),
  personId: z.string(),
  personName: z.string().nullable(),
  status: z.string(),
  currentStep: z.number(),
  nextSendAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  conversationId: z.string().nullable(),
});

export const getCampaignTool = defineTool({
  name: "get_campaign",
  title: "Get campaign",
  description: [
    "One campaign: its steps, senders, and one page of its leads by `tab` (`all`, `queued`, `in_sequence`, `paused`, `replied`, `finished`, `stopped`, `removed`) and `search`.",
    "With `previewStep`, it also renders that step with a real lead of the campaign, the way it would go out.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    channel: z.enum(CHANNELS),
    campaignId: z.string(),
    tab: z.enum(ENROLLMENT_TABS).optional(),
    search: z.string().optional(),
    page: z.number().int().optional(),
    previewStep: z.number().int().optional(),
  }),
  output: z.object({
    campaignId: z.string(),
    channel: z.enum(CHANNELS),
    name: z.string(),
    status: z.string(),
    steps: z.array(z.object({ stepNumber: z.number(), kind: z.string(), subject: z.string().nullable(), body: z.string(), waitDays: z.number() })),
    senders: z.array(z.object({ id: z.string(), label: z.string(), connected: z.boolean() })),
    enrollments: z.object({ total: z.number(), page: z.number(), pageSize: z.number(), rows: z.array(enrollment) }),
    preview: z.object({ stepNumber: z.number(), subject: z.string().nullable(), body: z.string(), leadName: z.string().nullable(), unresolved: z.array(z.object({ token: z.string(), reason: z.enum(["empty", "unknown"]) })) }).nullable(),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    // The campaign page's own reader picks the page size and trims the search.
    const query = parseEnrollmentListQuery({ tab: input.tab, q: input.search, page: input.page === undefined ? undefined : String(input.page), size: "20" });
    const base = { campaignId: input.campaignId, channel: input.channel, appUrl: appLinks(out).campaign(input.campaignId) };
    const toRow = (r: { enrollmentId: string; personId: string; personName: string | null; status: string; currentStep: number; nextSendAt: Date | null; lastSentAt: Date | null; stopReason: string | null; inboxConversationId: string | null }) => ({
      enrollmentId: r.enrollmentId,
      personId: r.personId,
      personName: r.personName,
      status: r.status,
      currentStep: r.currentStep,
      nextSendAt: iso(r.nextSendAt),
      lastSentAt: iso(r.lastSentAt),
      stopReason: r.stopReason,
      conversationId: r.inboxConversationId,
    });

    let structured;
    if (input.channel === "email") {
      const deps = campaignDeps();
      const [detail, senders, preview] = await Promise.all([
        getCampaignDetail(deps, actor, input.campaignId, query),
        getCampaignSenders(deps, actor, input.campaignId),
        input.previewStep === undefined ? null : previewStep(deps, actor, input.campaignId, input.previewStep),
      ]);
      structured = {
        ...base,
        name: detail.campaign.name,
        status: detail.campaign.status,
        steps: detail.campaign.steps.map((s) => ({ stepNumber: s.stepNumber, kind: s.kind, subject: s.subject ?? null, body: s.body, waitDays: s.waitDays })),
        senders: senders.assigned,
        enrollments: { total: detail.enrollments.total, page: query.page, pageSize: query.pageSize, rows: detail.enrollments.rows.map(toRow) },
        preview: preview && input.previewStep !== undefined ? { stepNumber: input.previewStep, subject: preview.subject, body: preview.bodyText, leadName: preview.leadName, unresolved: preview.unresolved } : null,
      };
    } else {
      const deps = linkedinCampaignDeps();
      const [detail, senders, preview] = await Promise.all([
        getLinkedInCampaignDetail(deps, actor, input.campaignId, query),
        getLinkedInCampaignSenders(deps, actor, input.campaignId),
        input.previewStep === undefined ? null : previewLinkedInStep(deps, actor, input.campaignId, input.previewStep),
      ]);
      structured = {
        ...base,
        name: detail.campaign.name,
        status: detail.campaign.status,
        steps: detail.campaign.steps.map((s) => ({ stepNumber: s.stepNumber, kind: s.kind, subject: s.subject ?? null, body: s.body, waitDays: s.waitDays })),
        senders: senders.assigned,
        enrollments: { total: detail.enrollments.total, page: query.page, pageSize: query.pageSize, rows: detail.enrollments.rows.map(toRow) },
        preview: preview && input.previewStep !== undefined ? { stepNumber: input.previewStep, subject: null, body: preview.text, leadName: preview.leadName, unresolved: preview.unresolved } : null,
      };
    }
    const summary = `${structured.name} (${input.channel}, ${structured.status}): ${structured.steps.length} steps, ${structured.senders.length} senders, ${structured.enrollments.total} leads in ${query.tab}.`;
    return { summary, structured };
  },
});
