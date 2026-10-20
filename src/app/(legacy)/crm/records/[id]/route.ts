import { connection, NextResponse } from "next/server";
import { activeConversationOfRecord } from "@/contexts/conversations/infrastructure/composition";
import { apiOrgContext } from "@/contexts/identity/infrastructure/session";

type Ctx = RouteContext<"/crm/records/[id]">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const temporaryRedirect = (location: string) => new NextResponse(null, { status: 307, headers: { Location: location } });

/**
 * The record page folded into the Inbox thread. An old link to one record opens the person's public conversation on
 * the active channel; anything else (a record with no public thread, another organization's id, no session) opens the
 * Pipeline. The redirect is temporary, so a browser does not keep it.
 */
export async function GET(_request: Request, ctx: Ctx) {
  await connection();
  const { id } = await ctx.params;
  const org = UUID.test(id) ? await apiOrgContext() : null;
  const conversation = org ? await activeConversationOfRecord(org.organization.id, id) : null;
  return temporaryRedirect(conversation ? `/inbox/${conversation.conversationId}` : "/crm/pipeline");
}
