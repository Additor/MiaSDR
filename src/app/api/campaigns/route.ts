import { z } from "zod";
import { MAX_CAMPAIGN_SENDERS } from "@/contexts/outreach/application/enrollment-admin";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { createCampaign, listCampaigns } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/** GET ?archived=only|all lists archived campaigns too. The default hides them. */
export const GET = (request: Request) => withActor((actor) => listCampaigns(campaignDeps(), actor, parseArchiveFilter(new URL(request.url).searchParams.get("archived"))));

export const POST = (request: Request) =>
  withActor(async (actor) => createCampaign(campaignDeps(), actor, z.object({ name: z.string(), senderIds: z.array(z.uuid()).max(MAX_CAMPAIGN_SENDERS).optional() }).parse(await request.json())), 201);
