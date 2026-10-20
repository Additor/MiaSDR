import { NextResponse } from "next/server";
import { getLinkedInWebhookSetup } from "@/contexts/outreach/linkedin/application/linkedin-management";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { withAdmin } from "@/shared/api";

/**
 * The webhook URL, header name and secret, for registering the webhooks by hand. Owner or admin only; every call is audited.
 * A POST, so a link, a prefetch or a crawler cannot trigger the reveal. There is no GET handler: Next answers 405.
 */
export async function POST() {
  let response: NextResponse;
  try {
    response = await withAdmin("Only an owner or admin can view the webhook setup.", (actor) => getLinkedInWebhookSetup(linkedinManagementDeps(), actor));
  } catch {
    response = NextResponse.json({ error: "Could not load the webhook setup." }, { status: 500 });
  }
  response.headers.set("cache-control", "no-store");
  return response;
}
