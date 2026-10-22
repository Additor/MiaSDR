import { z } from "zod";
import { createConnectLink } from "@/contexts/outreach/linkedin/application/linkedin-connect";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withAdmin } from "@/app/_lib/api";

/** POST {} connects a new LinkedIn account. POST { accountId } re-authenticates that account in place. Answers the single-use URL to navigate to. */
const body = z.object({ accountId: z.string().max(64).nullish() });

export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can connect LinkedIn accounts.", async (actor) => {
    const input = body.parse(await request.json().catch(() => ({})));
    const link = await createConnectLink(linkedinManagementDeps(), actor, { reconnectAccountId: input.accountId });
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), notify: link.notify, linkId: link.linkId };
  });
