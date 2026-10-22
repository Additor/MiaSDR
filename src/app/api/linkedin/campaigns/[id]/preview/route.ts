import { z } from "zod";
import { previewLinkedInStep } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";
import { linkedinStepSchema } from "../../step-schema";

export async function POST(request: Request, ctx: RouteContext<"/api/linkedin/campaigns/[id]/preview">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const body = z.object({ step: z.number().int().positive(), steps: z.array(linkedinStepSchema).optional() }).parse(await request.json());
    return previewLinkedInStep(linkedinCampaignDeps(), actor, id, body.step, body.steps);
  });
}
