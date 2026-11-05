import { z } from "zod";
import { cancelConnectLink, checkConnectLink } from "@/contexts/outreach/linkedin/application/linkedin-connect";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withAdmin } from "@/app/_lib/api";

const body = z.object({ linkId: z.uuid(), cancel: z.boolean().optional() });

/** For a vendor whose connect link does not report back. POST { linkId } asks how it stands, and adds the account once it connected. With `cancel`, gives up on the link. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can connect LinkedIn accounts.", async (actor) => {
    const input = body.parse(await request.json());
    if (!input.cancel) return checkConnectLink(linkedinManagementDeps(), actor, input.linkId);
    await cancelConnectLink(linkedinManagementDeps(), actor, input.linkId);
    return { status: "failed", error: null };
  });
