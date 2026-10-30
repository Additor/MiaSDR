import { z } from "zod";
import { leadActivityDeps, leadDeps, listLeads } from "@/composition/leads";
import { readLeadActivity } from "@/contexts/outreach/application/read-lead-activity";
import { getLead } from "@/contexts/people/application/lead-management";
import { LIFECYCLE_FILTERS, parseLeadFilter } from "@/contexts/people/domain/lead-filter";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, fencedField, iso, untrusted } from "./output";

const tristate = (value: boolean | undefined) => (value === undefined ? undefined : value ? "yes" : "no");

const person = z.object({
  personId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  lifecycle: z.string(),
  doNotContact: z.boolean(),
  appUrl: z.string(),
});

export const searchPeopleTool = defineTool({
  name: "search_people",
  title: "Search people",
  description: [
    "Leads and contacts, newest first, 50 a page, with the same filters as the Leads page. `query` matches name, email, title, company, LinkedIn and phone.",
    "`lifecycle` is `lead` (default), `contact` or `all`. `campaign` takes a campaign id, `any` or `none`.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    query: z.string().optional(),
    lifecycle: z.enum(LIFECYCLE_FILTERS).optional(),
    campaign: z.string().optional(),
    notInCampaignId: z.string().optional(),
    hasEmail: z.boolean().optional(),
    hasLinkedin: z.boolean().optional(),
    replied: z.boolean().optional(),
    hasConversation: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    page: z.number().int().optional(),
  }),
  output: z.object({ total: z.number(), page: z.number(), pageCount: z.number(), people: z.array(person) }),
  async run({ actor, out }, input) {
    // The Leads page's own URL reader drops values that do not parse, so the tool filters as the page does.
    const params: Record<string, string | undefined> = {
      q: input.query,
      lifecycle: input.lifecycle,
      campaign: input.campaign,
      notCampaign: input.notInCampaignId,
      email: tristate(input.hasEmail),
      linkedin: tristate(input.hasLinkedin),
      replied: tristate(input.replied),
      hasConversation: tristate(input.hasConversation),
      dnc: tristate(input.doNotContact),
    };
    const filter = parseLeadFilter((key) => params[key]);
    const result = await listLeads(actor, { filter, page: input.page });
    // listLeads answers the last page for a page past the end; the agent reads an empty page as the end instead.
    const pastEnd = input.page !== undefined && input.page > result.pageCount;
    const links = appLinks(out);
    const people = (pastEnd ? [] : result.rows).map((r) => ({
      personId: r.id,
      name: r.fullName,
      email: r.email,
      title: fencedField(out, r.title),
      company: fencedField(out, r.companyName ?? r.companyDomain),
      lifecycle: r.lifecycle,
      doNotContact: r.doNotContact,
      appUrl: links.person(r.id, r.lifecycle),
    }));
    const summary = `${result.total} people match. Page ${pastEnd ? input.page : result.page} of ${result.pageCount}: ${people.map((p) => p.name ?? p.email ?? p.personId).join(", ") || "none"}.`;
    return { summary, structured: { total: result.total, page: pastEnd ? input.page! : result.page, pageCount: result.pageCount, people } };
  },
});

export const getPersonTool = defineTool({
  name: "get_person",
  title: "Get person",
  description:
    "One lead or contact: contact details, custom fields, whether email and LinkedIn can reach them, campaign enrollments, the latest campaign sends and the newest conversation id.",
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({ personId: z.string() }),
  output: z.object({
    personId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    lifecycle: z.string(),
    status: z.string().nullable(),
    lastContactAt: z.string().nullable(),
    reach: z.object({ email: z.string(), linkedin: z.string(), doNotContact: z.boolean() }),
    customFields: z.record(z.string(), z.unknown()),
    conversationId: z.string().nullable(),
    enrollments: z.array(z.object({ campaignId: z.string(), campaignName: z.string(), channel: z.string(), status: z.string(), currentStep: z.number(), nextSendAt: z.string().nullable() })),
    sends: z.array(z.object({ campaignName: z.string(), stepNumber: z.number().nullable(), channel: z.string(), status: z.string(), subject: z.string().nullable(), sentAt: z.string().nullable() })),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    const lead = await getLead(leadDeps(), actor, input.personId);
    const p = lead.person;
    const activity = (await readLeadActivity(leadActivityDeps(), actor.organizationId, [{ id: p.id, lifecycle: p.lifecycle, email: p.email, linkedinSlug: p.linkedinSlug, linkedinUrl: p.linkedinUrl }])).get(p.id);
    // Custom fields by their names, which is how a person reads them.
    const labels = new Map(lead.customColumns.map((c) => [c.key, c.name]));
    const customFields = Object.fromEntries(
      Object.entries(p.custom)
        .filter(([key]) => labels.has(key))
        .map(([key, value]) => [labels.get(key)!, typeof value === "string" ? untrusted(out, "field", value) : value]),
    );
    const structured = {
      personId: p.id,
      name: p.fullName,
      email: p.email,
      phone: p.phone,
      linkedinUrl: p.linkedinUrl,
      title: fencedField(out, p.title),
      company: fencedField(out, p.companyName ?? p.companyDomain),
      lifecycle: p.lifecycle,
      status: activity?.status?.state ?? null,
      lastContactAt: iso(activity?.status?.lastContactAt ?? null),
      reach: { email: activity?.reach.email.state ?? "missing", linkedin: activity?.reach.linkedin.state ?? "missing", doNotContact: lead.policy?.doNotContact ?? false },
      customFields,
      conversationId: lead.conversationId,
      enrollments: lead.enrollments.map((e) => ({ campaignId: e.campaignId, campaignName: e.campaignName, channel: e.channel, status: e.status, currentStep: e.currentStep, nextSendAt: iso(e.nextSendAt) })),
      sends: lead.sends.map((s) => ({ campaignName: s.campaignName, stepNumber: s.stepNumber, channel: s.channel, status: s.status, subject: s.subject, sentAt: iso(s.sentAt) })),
      appUrl: appLinks(out).person(p.id, p.lifecycle),
    };
    const summary = `${p.fullName ?? p.email ?? p.id}, ${p.lifecycle}${structured.status ? `, ${structured.status}` : ""}. ${lead.enrollments.length} enrollments, ${lead.sends.length} campaign sends.`;
    return { summary, structured };
  },
});
