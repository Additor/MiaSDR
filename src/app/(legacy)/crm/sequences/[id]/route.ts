import { connection, NextResponse } from "next/server";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";
import { campaignIdOfSequence } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";

type Ctx = RouteContext<"/crm/sequences/[id]">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const temporaryRedirect = (location: string) => new NextResponse(null, { status: 307, headers: { Location: location } });

/**
 * The CRM Sequences screen moved into each campaign. A link to one sequence opens the After a reply setting of the
 * campaign that owns it; anything else (a legacy standalone sequence, another organization's id, no session) opens
 * the campaign list. The redirect is temporary, so a browser does not keep it.
 */
export async function GET(_request: Request, ctx: Ctx) {
  await connection();
  const { id } = await ctx.params;
  const org = UUID.test(id) ? await apiOrgContext() : null;
  const campaignId = org ? await campaignIdOfSequence(org.organization.id, id) : null;
  return temporaryRedirect(campaignId ? `/campaigns/${campaignId}?tab=settings` : "/campaigns");
}
