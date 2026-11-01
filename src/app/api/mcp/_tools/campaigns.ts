import { z } from "zod";
import { getCampaignDetail, listCampaigns, previewStep } from "@/contexts/outreach/application/campaign-management";
import { listAssignedSenders } from "@/contexts/outreach/application/enrollment-admin";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { ENROLLMENT_TABS, parseEnrollmentListQuery } from "@/contexts/outreach/domain/enrollment-list";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import type { UnresolvedToken } from "@/contexts/outreach/domain/variables";
import { getLinkedInCampaignDetail, listLinkedInCampaigns, previewLinkedInStep } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { defineTool, READ_ONLY } from "./define";
import type { Actor } from "@/shared/errors";
import { appLinks, clip, DEFAULT_LIST_LIMIT, fencedField, fitItems, iso, UNTRUSTED_NOTE, untrusted } from "./output";

export const CHANNELS = ["email", "linkedin"] as const;

/** Characters of a step body get_campaign keeps, except the step it previews, which comes whole. */
const STEP_BODY_CHARS = 300;
/** Characters of a rendered step preview an answer keeps. */
const PREVIEW_CHARS = 4000;

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
  output: z.object({ campaigns: z.array(summaryRow), omitted: z.number() }),
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
    const fitted = fitItems(campaigns);
    const lines = fitted.items.map((c) => `${c.name} (${c.channel}, ${c.status}): ${c.enrolled} enrolled, ${c.replied} replied`);
    if (fitted.omitted > 0) lines.push(`${fitted.omitted} more left out; filter by channel or archive state.`);
    return { summary: lines.length === 0 ? "No campaigns." : lines.join("\n"), structured: { campaigns: fitted.items, omitted: fitted.omitted } };
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

type EnrollmentQuery = ReturnType<typeof parseEnrollmentListQuery>;
type Step = { stepNumber: number; kind: string; subject?: string; body: string; waitDays: number };
type Row = { enrollmentId: string; personId: string; personName: string | null; status: string; currentStep: number; nextSendAt: Date | null; lastSentAt: Date | null; stopReason: string | null; inboxConversationId: string | null };

/** What get_campaign and `campaignStatus` read of one channel. Both channels answer in the same shape. */
interface ChannelReads {
  detail(actor: Actor, id: string, query: EnrollmentQuery): Promise<{ campaign: { name: string; status: string; steps: Step[] }; enrollments: { total: number; rows: Row[] } }>;
  preview(actor: Actor, id: string, stepNumber: number): Promise<{ subject: string | null; body: string; leadName: string | null; usedSampleLead: boolean; unresolved: UnresolvedToken[] }>;
}

const READS: Record<(typeof CHANNELS)[number], ChannelReads> = {
  email: {
    detail: (actor, id, query) => getCampaignDetail(campaignDeps(), actor, id, query),
    preview: async (actor, id, stepNumber) => {
      const p = await previewStep(campaignDeps(), actor, id, stepNumber);
      return { subject: p.subject, body: p.bodyText, leadName: p.leadName, usedSampleLead: p.usedSampleLead, unresolved: p.unresolved };
    },
  },
  linkedin: {
    detail: (actor, id, query) => getLinkedInCampaignDetail(linkedinCampaignDeps(), actor, id, query),
    preview: async (actor, id, stepNumber) => {
      const p = await previewLinkedInStep(linkedinCampaignDeps(), actor, id, stepNumber);
      return { subject: null, body: p.text, leadName: p.leadName, usedSampleLead: p.usedSampleLead, unresolved: p.unresolved };
    },
  },
};

/** A campaign's status for the write tools that check it first. A foreign or wrong-channel id answers not found. */
export const campaignStatus = async (actor: Actor, channel: (typeof CHANNELS)[number], campaignId: string): Promise<string> =>
  (await READS[channel].detail(actor, campaignId, parseEnrollmentListQuery({ size: "1" }))).campaign.status;

/** A step body as written: cut to an excerpt, or whole for the previewed step. */
const bodyOf = (body: string, whole: boolean): { body: string; truncated: boolean } => {
  const { text, truncated } = whole ? { text: body, truncated: false } : clip(body, STEP_BODY_CHARS);
  return { body: text, truncated };
};

export const getCampaignTool = defineTool({
  name: "get_campaign",
  title: "Get campaign",
  description: [
    "One campaign: its steps, senders, and one page of its leads by `tab` (`all`, `queued`, `in_sequence`, `paused`, `replied`, `finished`, `stopped`, `removed`) and `search`.",
    "Step bodies keep 300 characters and mark a longer one `truncated`. With `previewStep`, that step's body comes whole, and the answer renders it the way it would go out, with a lead of the campaign, or sample values while it has none (`usedSampleLead`).",
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
    steps: z.array(z.object({ stepNumber: z.number(), kind: z.string(), subject: z.string().nullable(), body: z.string(), truncated: z.boolean(), waitDays: z.number() })),
    senders: z.array(z.object({ id: z.string(), label: z.string(), connected: z.boolean() })),
    enrollments: z.object({ total: z.number(), page: z.number(), pageSize: z.number(), rows: z.array(enrollment) }),
    preview: z
      .object({ stepNumber: z.number(), subject: z.string().nullable(), body: z.string(), truncated: z.boolean(), leadName: z.string().nullable(), usedSampleLead: z.boolean(), unresolved: z.array(z.object({ token: z.string(), reason: z.enum(["empty", "unknown"]) })) })
      .nullable(),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    const reads = READS[input.channel];
    // The campaign page's own reader picks the page size and trims the search.
    const query = parseEnrollmentListQuery({ tab: input.tab, q: input.search, page: input.page === undefined ? undefined : String(input.page), size: String(DEFAULT_LIST_LIMIT) });
    // The detail loads the campaign first, so a foreign or wrong-channel id answers not found before anything else runs.
    const detail = await reads.detail(actor, input.campaignId, query);
    const { steps } = detail.campaign;
    const step = input.previewStep;
    const inRange = step !== undefined && step >= 1 && step <= steps.length;
    const [senders, preview] = await Promise.all([listAssignedSenders(campaignDeps(), actor, input.channel, input.campaignId), inRange ? reads.preview(actor, input.campaignId, step) : null]);
    const rendered = preview ? clip(preview.body, PREVIEW_CHARS) : null;
    const structured = {
      campaignId: input.campaignId,
      channel: input.channel,
      name: detail.campaign.name,
      status: detail.campaign.status,
      steps: steps.map((s) => ({ stepNumber: s.stepNumber, kind: s.kind, subject: s.subject ?? null, ...bodyOf(s.body, s.stepNumber === step), waitDays: s.waitDays })),
      senders,
      enrollments: {
        total: detail.enrollments.total,
        page: query.page,
        pageSize: query.pageSize,
        rows: detail.enrollments.rows.map((r) => ({
          enrollmentId: r.enrollmentId,
          personId: r.personId,
          personName: r.personName,
          status: r.status,
          currentStep: r.currentStep,
          nextSendAt: iso(r.nextSendAt),
          lastSentAt: iso(r.lastSentAt),
          stopReason: r.stopReason,
          conversationId: r.inboxConversationId,
        })),
      },
      // The rendered text carries a lead's own values, so it comes fenced like any imported field.
      preview: preview && rendered && step !== undefined ? { stepNumber: step, subject: fencedField(out, preview.subject), body: untrusted(out, "field", rendered.text), truncated: rendered.truncated, leadName: preview.leadName, usedSampleLead: preview.usedSampleLead, unresolved: preview.unresolved } : null,
      appUrl: appLinks(out).campaign(input.campaignId),
    };
    const lines = [`${structured.name} (${input.channel}, ${structured.status}): ${steps.length} steps, ${senders.length} senders, ${structured.enrollments.total} leads in ${query.tab}.`];
    if (step !== undefined && !inRange) lines.push(`Step ${step} does not exist; the campaign has ${steps.length}.`);
    if (preview) lines.push(UNTRUSTED_NOTE);
    return { summary: lines.join("\n"), structured };
  },
});
