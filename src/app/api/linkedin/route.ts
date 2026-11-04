import { z } from "zod";
import { connectLinkedIn, disconnectLinkedIn, listLinkedInAccounts } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withActor, withAdmin } from "@/app/_lib/api";

/** `vendor` names who to connect through, and the rest is what that vendor asks for. */
const connectBody = z.object({ vendor: z.string().max(20).optional(), dsn: z.string().max(200).optional(), apiKey: z.string().max(500) }).transform((value) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Record<string, string>);

export const GET = () => withAdmin("Only an owner or admin can manage LinkedIn.", (actor) => listLinkedInAccounts(linkedinManagementDeps(), actor));

export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can manage LinkedIn.", async (actor) => connectLinkedIn(linkedinManagementDeps(), actor, connectBody.parse(await request.json())));

export const DELETE = () =>
  withActor(async (actor) => {
    await disconnectLinkedIn(linkedinManagementDeps(), actor);
    return { ok: true };
  });
