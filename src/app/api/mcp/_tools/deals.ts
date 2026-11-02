import { z } from "zod";
import { dealsDeps } from "@/composition/deals";
import { moveDealStage, updateDeal } from "@/contexts/deals/application/deal-edit";
import type { DealView } from "@/contexts/deals/application/deal-reads";
import { ValidationError } from "@/shared/errors";
import { CHANGES, defineTool } from "./define";
import { appLinks, unfenced } from "./output";

const ACTIONS = ["move_stage", "edit"] as const;

export const updateDealTool = defineTool({
  name: "update_deal",
  title: "Update deal",
  description: [
    "Changes a deal (`dealId`, `expectedVersion` from get_pipeline). `move_stage` moves it to `stageId`, with an optional `lostReason` for a Lost stage;",
    "`edit` changes `title`, `ownerId` (a user id or null), `amount` with `currency`, or `expectedCloseOn` (YYYY-MM-DD or null).",
    "Someone else's change since then answers `stale_version` with the current version.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(ACTIONS),
    dealId: z.string(),
    expectedVersion: z.number().int(),
    stageId: z.string().optional(),
    lostReason: z.string().nullable().optional(),
    title: z.string().optional(),
    ownerId: z.string().nullable().optional(),
    amount: z.union([z.string(), z.number()]).nullable().optional(),
    currency: z.string().nullable().optional(),
    expectedCloseOn: z.string().nullable().optional(),
  }),
  output: z.object({
    action: z.enum(ACTIONS),
    dealId: z.string(),
    version: z.number(),
    stage: z.object({ stageId: z.string(), name: z.string(), kind: z.string() }),
    owner: z.string().nullable(),
    amountMinor: z.number().nullable(),
    currency: z.string().nullable(),
    expectedCloseOn: z.string().nullable(),
    appUrl: z.string(),
  }),
  async run({ actor, out }, input) {
    let deal: DealView;
    if (input.action === "move_stage") {
      if (!input.stageId) throw new ValidationError("move_stage needs stageId.");
      deal = await moveDealStage(dealsDeps(), actor, input.dealId, { stageId: input.stageId, expectedVersion: input.expectedVersion, lostReason: input.lostReason });
    } else {
      const { title, ownerId, amount, currency, expectedCloseOn } = input;
      if ([title, ownerId, amount, currency, expectedCloseOn].every((v) => v === undefined)) throw new ValidationError("edit needs a field to change.");
      deal = await updateDeal(dealsDeps(), actor, input.dealId, { expectedVersion: input.expectedVersion, title: title && unfenced(title), ownerId, amount, currency, expectedCloseOn });
    }
    return {
      summary: `Deal ${deal.id}: ${deal.stage.name}, version ${deal.version}.`,
      structured: {
        action: input.action,
        dealId: deal.id,
        version: deal.version,
        stage: { stageId: deal.stage.id, name: deal.stage.name, kind: deal.stage.kind },
        owner: deal.owner?.name ?? null,
        amountMinor: deal.amountMinor,
        currency: deal.currency,
        expectedCloseOn: deal.expectedCloseOn,
        appUrl: appLinks(out).deal(deal.id),
      },
    };
  },
});
