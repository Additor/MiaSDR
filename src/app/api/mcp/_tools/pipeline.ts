import { z } from "zod";
import { dealsDeps } from "@/composition/deals";
import { board, getDeal } from "@/contexts/deals/application/deal-reads";
import { defineTool, READ_ONLY } from "./define";
import { appLinks, DEFAULT_LIST_LIMIT, fencedField, iso, OVERVIEW_LIMIT } from "./output";

const card = z.object({
  dealId: z.string(),
  title: z.string(),
  version: z.number(),
  personId: z.string(),
  personName: z.string().nullable(),
  company: z.string().nullable(),
  amountMinor: z.number().nullable(),
  currency: z.string().nullable(),
  owner: z.string().nullable(),
  expectedCloseOn: z.string().nullable(),
  appUrl: z.string(),
});

export const getPipelineTool = defineTool({
  name: "get_pipeline",
  title: "Get pipeline",
  description: [
    "The deal pipeline: one column per stage with its deal count, amounts and its 5 newest deals (20 with `stageId`). Won and Lost hold the last 30 days unless `showAll`. Filter by `owner` (a user id, `me` or `none`) or `query`; page one stage with `stageId` and its `nextCursor`.",
    "With `dealId`, it answers that one deal instead, with the `version` that edits take.",
  ].join(" "),
  scope: "mcp:read",
  annotations: READ_ONLY,
  input: z.object({
    dealId: z.string().optional(),
    stageId: z.string().optional(),
    owner: z.string().optional(),
    query: z.string().optional(),
    cursor: z.string().optional(),
    showAll: z.boolean().optional(),
  }),
  output: z.object({
    columns: z.array(z.object({ stageId: z.string().nullable(), name: z.string(), kind: z.string(), total: z.number(), amounts: z.array(z.object({ currency: z.string(), amountMinor: z.string() })), deals: z.array(card), nextCursor: z.string().nullable() })),
    deal: z
      .object({
        dealId: z.string(),
        title: z.string(),
        version: z.number(),
        stage: z.object({ stageId: z.string(), name: z.string(), kind: z.string() }),
        owner: z.string().nullable(),
        amountMinor: z.number().nullable(),
        currency: z.string().nullable(),
        expectedCloseOn: z.string().nullable(),
        closedAt: z.string().nullable(),
        lostReason: z.string().nullable(),
        sourceCampaign: z.string().nullable(),
        person: z.object({ personId: z.string(), name: z.string().nullable(), email: z.string().nullable(), company: z.string().nullable() }),
        appUrl: z.string(),
      })
      .nullable(),
  }),
  async run({ actor, out }, input) {
    const links = appLinks(out);
    if (input.dealId) {
      const d = await getDeal(dealsDeps(), actor, input.dealId);
      const deal = {
        dealId: d.id,
        // A deal's default title repeats the lead's name and company.
        title: fencedField(out, d.title) ?? "",
        version: d.version,
        stage: { stageId: d.stage.id, name: d.stage.name, kind: d.stage.kind },
        owner: d.owner?.name ?? null,
        amountMinor: d.amountMinor,
        currency: d.currency,
        expectedCloseOn: d.expectedCloseOn,
        closedAt: iso(d.closedAt),
        lostReason: d.lostReason,
        sourceCampaign: d.source?.campaignName ?? null,
        person: { personId: d.person.id, name: d.person.name, email: d.person.email, company: fencedField(out, d.person.companyName) },
        appUrl: links.deal(d.id),
      };
      return { summary: `Deal ${d.id}: ${d.stage.name}, version ${d.version}.`, structured: { columns: [], deal } };
    }
    const limit = input.stageId ? DEFAULT_LIST_LIMIT : OVERVIEW_LIMIT;
    const result = await board(dealsDeps(), actor, { stage: input.stageId, owner: input.owner, q: input.query, limit, cursor: input.cursor, showAll: input.showAll });
    const columns = result.columns.map((c) => ({
      stageId: c.id,
      name: c.name,
      kind: c.kind,
      total: c.total,
      amounts: c.amounts,
      nextCursor: c.nextCursor,
      deals: c.cards.map((k) => ({ dealId: k.id, title: fencedField(out, k.title) ?? "", version: k.version, personId: k.personId, personName: k.personName, company: fencedField(out, k.companyName), amountMinor: k.amountMinor, currency: k.currency, owner: k.owner?.name ?? null, expectedCloseOn: k.expectedCloseOn, appUrl: links.deal(k.id) })),
    }));
    return { summary: columns.map((c) => `${c.name}: ${c.total}`).join(", "), structured: { columns, deal: null } };
  },
});
