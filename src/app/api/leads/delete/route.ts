import { z } from "zod";
import { MAX_DELETE_IDS, deleteLeads } from "@/contexts/people/application/lead-management";
import { LIFECYCLE_FILTERS, parseLeadFilter } from "@/contexts/people/domain/lead-filter";
import { leadDeleteDeps } from "@/composition/person-lifecycle";
import { withActor } from "@/app/_lib/api";

/** Every `LeadFilter` key the list sends except `ids`, which belong to the other branch. */
const filterSchema = z
  .object({
    query: z.string().max(100),
    campaign: z.string().max(40),
    notInCampaign: z.string().max(40),
    hasEmail: z.boolean(),
    hasLinkedin: z.boolean(),
    doNotContact: z.boolean(),
    replied: z.boolean(),
    hasConversation: z.boolean(),
    lifecycle: z.enum(LIFECYCLE_FILTERS),
    lastContactFrom: z.string().max(10),
    lastContactTo: z.string().max(10),
    source: z.string().max(170),
    createdFrom: z.string().max(10),
    createdTo: z.string().max(10),
    category: z.string().max(40),
  })
  .partial()
  .strict();

const schema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(MAX_DELETE_IDS) }),
  // `query` stays as shorthand for a filter that holds only a search.
  z.object({ query: z.string().max(100).optional(), filter: filterSchema.optional(), confirmCount: z.number().int().min(0) }),
]);

const yesNo = (value: boolean | undefined) => (value === undefined ? undefined : value ? "yes" : "no");

/** Bulk delete by selection (`ids`) or by the current filter (`filter` plus the count the person confirmed). An empty filter answers 422. */
export async function POST(request: Request) {
  return withActor(async (actor) => {
    const body = schema.parse(await request.json());
    if ("ids" in body) {
      const outcome = await deleteLeads(leadDeleteDeps, actor, { ids: body.ids });
      return { deleted: outcome.deleted, blockedCount: outcome.blocked.length, blocked: outcome.blocked.slice(0, 20) };
    }
    // The same parser as the URL, so a value that does not parse is dropped here too and cannot widen or skip a condition.
    const f = body.filter ?? {};
    const raw: Record<string, string | undefined> = {
      q: f.query ?? body.query,
      campaign: f.campaign,
      notCampaign: f.notInCampaign,
      email: yesNo(f.hasEmail),
      linkedin: yesNo(f.hasLinkedin),
      dnc: yesNo(f.doNotContact),
      replied: yesNo(f.replied),
      hasConversation: yesNo(f.hasConversation),
      lifecycle: f.lifecycle,
      lastFrom: f.lastContactFrom,
      lastTo: f.lastContactTo,
      source: f.source,
      from: f.createdFrom,
      to: f.createdTo,
      category: f.category,
    };
    const outcome = await deleteLeads(leadDeleteDeps, actor, { filter: parseLeadFilter((key) => raw[key]), confirmCount: body.confirmCount });
    return { deleted: outcome.deleted, blockedCount: outcome.blocked.length, blocked: outcome.blocked.slice(0, 20) };
  });
}
