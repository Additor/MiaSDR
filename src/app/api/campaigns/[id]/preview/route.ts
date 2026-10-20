import { z } from "zod";
import { previewStep } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/shared/api";
import { stepSchema } from "../../step-schema";

export async function POST(request: Request, ctx: RouteContext<"/api/campaigns/[id]/preview">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ step: z.number().int().positive(), steps: z.array(stepSchema).optional() }).parse(await request.json());
    return previewStep(campaignDeps(), actor, id, body.step, body.steps);
  });
}
