import { z } from "zod";
import { connectLinkedIn, disconnectLinkedIn, listLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor, withAdmin } from "@/shared/api";

export const GET = () => withActor((actor) => listLinkedInAccounts(linkedinManagementDeps(), actor));

export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can manage LinkedIn.", async (actor) => connectLinkedIn(linkedinManagementDeps(), actor, z.object({ dsn: z.string().max(200), apiKey: z.string().max(500) }).parse(await request.json())));

export const DELETE = () =>
  withActor(async (actor) => {
    await disconnectLinkedIn(linkedinManagementDeps(), actor);
    return { ok: true };
  });
