import { z } from "zod";
import { createLinkedInSearch } from "@/contexts/outreach/linkedin/application/linkedin-search";
import { linkedinSearchDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor } from "@/app/_lib/api";

const body = z.object({
  name: z.string(),
  url: z.string(),
  maxResults: z.number().int().optional(),
  campaignId: z.string().uuid().nullish(),
});

export const POST = (request: Request) => withActor(async (actor) => createLinkedInSearch(linkedinSearchDeps(), actor, body.parse(await request.json())), 201);
