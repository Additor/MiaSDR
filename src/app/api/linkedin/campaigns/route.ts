import { z } from "zod";
import { MAX_CAMPAIGN_SENDERS } from "@/contexts/outreach/application/enrollment-admin";
import { parseArchiveFilter } from "@/contexts/outreach/domain/campaign";
import { createLinkedInCampaign, listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

/** GET ?archived=only|all lists archived campaigns too. The default hides them. */
export const GET = (request: Request) => withActor((actor) => listLinkedInCampaigns(linkedinCampaignDeps(), actor, parseArchiveFilter(new URL(request.url).searchParams.get("archived"))));

export const POST = (request: Request) =>
  withActor(async (actor) => createLinkedInCampaign(linkedinCampaignDeps(), actor, z.object({ name: z.string(), type: z.enum(["regular", "personal"]).optional(), senderIds: z.array(z.uuid()).max(MAX_CAMPAIGN_SENDERS).optional() }).parse(await request.json())), 201);
