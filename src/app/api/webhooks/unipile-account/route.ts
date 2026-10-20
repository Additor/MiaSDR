import { NextResponse, connection } from "next/server";
import { receiveConnectNotify } from "@/contexts/outreach/linkedin/application/linkedin-connect";
import { linkedinManagementDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";

/**
 * Unipile hosted-auth callback (`notify_url`). The URL carries `?link=<id>&secret=<secret>`: Unipile signs nothing,
 * so the secret in the URL is the authentication, checked against the stored hash. Wrong id or secret answers 401.
 * A repeat of a finished link answers 200 and changes nothing.
 */
export async function POST(request: Request) {
  await connection();
  const url = new URL(request.url);
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // Authentication comes first, so an unreadable body from a stranger still answers 401 below.
  }
  const result = await receiveConnectNotify(linkedinManagementDeps(), { linkId: url.searchParams.get("link") ?? "", secret: url.searchParams.get("secret") ?? "", payload });
  if (result.status === 200) return NextResponse.json({ ok: true, outcome: result.outcome });
  return NextResponse.json({ error: result.status === 401 ? "unauthorized" : result.status === 410 ? "link expired" : result.status === 400 ? "invalid payload" : "try again" }, { status: result.status });
}
